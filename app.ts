// SPDX-License-Identifier: MIT
// app.ts — the forge's HTTP server: health probe, REST v3, GraphQL v4, MCP and git smart HTTP.
// Node built-ins only. The store is in-memory and deterministic (fixed timestamps, no randomness).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  sidebandPack,
  writePack,
  ZERO_OID,
} from './gitproto.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Pull,
  type Repo,
} from './store.ts';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { handleMcp, issueJson, repoJson } from './mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';

// GitHub-style rate-limit surface (RULES.txt does not require it, but the API
// root already advertises rate_limit_url and real clients read these headers).
// Deterministic by design: no wall clock anywhere — the reset is the fixed
// commit epoch + one hour, and `remaining` counts down from the request
// sequence, so a replay of the same request order sees the same values.
const RATE_LIMIT = 5000;
const RATE_LIMIT_RESET = 1700000000 + 3600;
let rateLimitUsed = 0;

function rateLimitHeaders(): Record<string, string> {
  rateLimitUsed += 1;
  const remaining = Math.max(0, RATE_LIMIT - rateLimitUsed);
  return {
    'x-ratelimit-limit': String(RATE_LIMIT),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(RATE_LIMIT_RESET),
    'x-ratelimit-used': String(rateLimitUsed),
  };
}

const store = new Store();

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const allHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': store.nextRequestId(),
    ...rateLimitHeaders(),
    ...headers,
  };
  if (status !== 204) allHeaders['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, allHeaders);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
    ...rateLimitHeaders(),
  });
  res.end(body);
}

function pathOf(url: URL): string {
  return url.pathname;
}

function queryOf(url: URL): URLSearchParams {
  return url.searchParams;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      if (total > 256 * 1024 * 1024) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: null when empty, {error} when malformed. */
function parseJsonBody(raw: Buffer): { value: unknown } | { error: string } {
  if (raw.length === 0) return { value: null };
  try {
    return { value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { error: 'the request body is not valid JSON' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${path}`;
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  const parts = [`<${absoluteUrl(req, `${basePath}?${next.toString()}`)}>; rel="next"`];
  const last = new URLSearchParams(query);
  last.set('page', String(totalPages));
  last.set('per_page', String(perPage));
  parts.push(`<${absoluteUrl(req, `${basePath}?${last.toString()}`)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; pageNum: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage };
}

// --------------------------------------------------------------------------- REST

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64url'),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
  };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(url);
  const query = queryOf(url);
  const segments = segmentsOf(path.replace(/^\/api\/v3/, '') || '/');

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // /meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // /rate_limit — GitHub-shaped quota report; the core bucket is the one the
  // X-RateLimit-* headers on every reply count down from. sendJson counts this
  // reply as one more use, so the body reports used + 1 to match its headers.
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    const used = rateLimitUsed + 1;
    const bucket = (limit: number, usedCount: number): Record<string, unknown> => ({
      limit,
      remaining: Math.max(0, limit - usedCount),
      reset: RATE_LIMIT_RESET,
      used: usedCount,
    });
    return sendJson(res, 200, {
      resources: {
        core: bucket(RATE_LIMIT, used),
        search: bucket(30, 0),
        graphql: bucket(RATE_LIMIT, used),
        code_scanning_upload: bucket(RATE_LIMIT, used),
      },
      rate: bucket(RATE_LIMIT, used),
    });
  }

  // /user
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, userJson());
  }

  // /user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, pageNum, perPage } = paginate(repos, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', query, pageNum, perPage, repos.length);
      if (link !== null) headers.link = link;
      return sendJson(res, 200, page.map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if ('error' in parsed) return sendError(res, 400, parsed.error);
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return sendError(res, 422, `Validation Failed: repository ${VIEWER_LOGIN}/${name} already exists`);
      }
      const repo = store.createRepo(
        name,
        body.private === true,
        typeof body.description === 'string' ? body.description : '',
      );
      return sendJson(res, 201, repoJson(store, repo));
    }
    return sendError(res, 404, 'Not Found');
  }

  // /repos/{owner}/{repo}[/...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const repoName = segments[2];
    const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
    const rest = segments.slice(3);
    if (repo === undefined) return sendError(res, 404, 'Not Found');

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(store, repo));
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if ('error' in parsed) return sendError(res, 400, parsed.error);
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        repo.updatedAt = FIXED_ISO;
        return sendJson(res, 200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return sendJson(res, 204, null);
      }
      return sendError(res, 404, 'Not Found');
    }

    // /branches
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
      return sendJson(res, 200, branches);
    }
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
    }

    // /commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveCommit(repo, ref);
      if (tip === undefined) return sendJson(res, 200, []);
      const commits: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        commits.push({
          sha: oid,
          commit: {
            message: commit.message.replace(/\n$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            tree: { sha: commit.tree },
          },
          author: { login: VIEWER_LOGIN, id: VIEWER_ID },
          committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        });
        for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
      }
      return sendJson(res, 200, commits);
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if ('error' in parsed) return sendError(res, 400, parsed.error);
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return sendError(res, 422, 'Validation Failed: ref and sha are required');
        if (repo.refs.has(ref)) return sendError(res, 422, `Validation Failed: ref ${ref} already exists`);
        if (repo.objects.get(sha) === undefined) return sendError(res, 422, `Validation Failed: object ${sha} does not exist`);
        repo.refs.set(ref, sha);
        return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(refName);
        if (sha === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, { ref: refName, object: { sha, type: 'commit' } });
      }
      return sendError(res, 404, 'Not Found');
    }

    // /contents/{path}
    if (rest[0] === 'contents' && rest.length >= 2) {
      const filePath = rest.slice(1).join('/');
      const ref = query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = store.resolveCommit(repo, ref);
        if (tip === undefined) return sendError(res, 404, 'Not Found');
        const rootTree = store.commitTree(repo, tip);
        const dir = store.treeDirAt(repo, rootTree, filePath);
        if (dir !== null) {
          const entries = dir.map((entry) => {
            const isDir = entry.mode === '40000';
            const blob = isDir ? undefined : repo.objects.get(entry.oid);
            return {
              type: isDir ? 'dir' : 'file',
              name: entry.name,
              path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
              sha: entry.oid,
              size: blob?.type === 'blob' ? blob.data.length : 0,
              url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath === '' ? entry.name : `${filePath}/${entry.name}`}`,
            };
          });
          return sendJson(res, 200, entries);
        }
        const found = store.treeEntryAt(repo, rootTree, filePath);
        if (found === null || found.mode === '40000') return sendError(res, 404, 'Not Found');
        const blob = repo.objects.get(found.oid);
        if (!blob || blob.type !== 'blob') return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: found.oid,
          size: blob.data.length,
          content: blob.data.toString('base64'),
          url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        });
      }
      if (method === 'PUT') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if ('error' in parsed) return sendError(res, 400, parsed.error);
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
        const currentTree = store.branchTree(repo, branch);
        const current = currentTree === undefined ? null : store.treeEntryAt(repo, currentTree, filePath);
        if (givenSha !== undefined) {
          if (current === null || current.oid !== givenSha) {
            return sendError(res, 409, 'Conflict: the file was updated by another commit (stale sha)');
          }
        }
        const isCreate = current === null;
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const { commitSha, blobSha } = store.commitContents(repo, branch, filePath, content, message);
        return sendJson(res, isCreate ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if ('error' in parsed) return sendError(res, 400, parsed.error);
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
        const currentTree = store.branchTree(repo, branch);
        const current = currentTree === undefined ? null : store.treeEntryAt(repo, currentTree, filePath);
        if (current === null) return sendError(res, 404, 'Not Found');
        if (givenSha !== undefined && current.oid !== givenSha) {
          return sendError(res, 409, 'Conflict: the file was updated by another commit (stale sha)');
        }
        const { commitSha } = store.commitContents(repo, branch, filePath, null, message);
        return sendJson(res, 200, { commit: { sha: commitSha, message } });
      }
      return sendError(res, 404, 'Not Found');
    }

    // /labels
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if ('error' in parsed) return sendError(res, 400, parsed.error);
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      const existing = repo.labels.get(name);
      if (existing) return sendJson(res, 201, { name: existing.name, color: existing.color, description: '' });
      repo.labels.set(name, { name, color });
      return sendJson(res, 201, { name, color, description: '' });
    }

    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let issues = [...repo.issues.values()];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, pageNum, perPage } = paginate(issues, query);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, query, pageNum, perPage, issues.length);
          if (link !== null) headers.link = link;
          return sendJson(res, 200, page.map((issue) => issueJson(store, repo, issue)), headers);
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if ('error' in parsed) return sendError(res, 400, parsed.error);
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const entry of labelsRaw) {
            const labelName = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
            const label = repo.labels.get(labelName);
            if (label === undefined) return sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
            labels.push(label);
          }
          const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
          return sendJson(res, 201, issueJson(store, repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return sendError(res, 404, 'Not Found');
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (issue === undefined) return sendError(res, 404, 'Not Found');
        if (method === 'GET') return sendJson(res, 200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if ('error' in parsed) return sendError(res, 400, parsed.error);
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? FIXED_ISO : null;
          }
          issue.updatedAt = FIXED_ISO;
          return sendJson(res, 200, issueJson(store, repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (issue === undefined) return sendError(res, 404, 'Not Found');
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          })));
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if ('error' in parsed) return sendError(res, 400, parsed.error);
          const body = isRecord(parsed.value) ? parsed.value : {};
          const commentBody = typeof body.body === 'string' ? body.body : '';
          const comment = { id: repo.nextCommentId++, body: commentBody, createdAt: FIXED_ISO };
          issue.comments.push(comment);
          return sendJson(res, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          });
        }
        return sendError(res, 404, 'Not Found');
      }
      return sendError(res, 404, 'Not Found');
    }

    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let pulls = [...repo.pulls.values()];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') pulls = pulls.filter((pull) => (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
          pulls.sort((a, b) => b.number - a.number);
          const { page, pageNum, perPage } = paginate(pulls, query);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/pulls`, query, pageNum, perPage, pulls.length);
          if (link !== null) headers.link = link;
          return sendJson(res, 200, page.map((pull) => pullJson(store, repo, pull)), headers);
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if ('error' in parsed) return sendError(res, 400, parsed.error);
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : '';
          const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if (pull === null) return sendError(res, 422, 'Validation Failed: head or base branch does not exist');
          return sendJson(res, 201, pullJson(store, repo, pull));
        }
        return sendError(res, 404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return sendError(res, 404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (pull === undefined) return sendError(res, 404, 'Not Found');
        if (method === 'GET') return sendJson(res, 200, pullJson(store, repo, pull));
        return sendError(res, 404, 'Not Found');
      }
      if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
        if (pull === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, store.pullFiles(repo, pull));
      }
      if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
        if (pull === undefined) return sendError(res, 404, 'Not Found');
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if ('error' in parsed) return sendError(res, 400, parsed.error);
        if (pull.merged && pull.mergeCommitSha !== null) {
          return sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: `Merged pull request #${pull.number}` });
        }
        const sha = store.mergePull(repo, pull);
        if (sha === null) return sendError(res, 405, 'Conflict: the pull request cannot be merged (conflicted)');
        return sendJson(res, 200, { sha, merged: true, message: `Merged pull request #${pull.number}` });
      }
      return sendError(res, 404, 'Not Found');
    }

    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// --------------------------------------------------------------------------- git smart HTTP

interface AdRef {
  oid: string;
  name: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): AdRef[] {
  const refs: AdRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdRef = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') entry.peeled = parseTag(object.data).object;
    }
    refs.push(entry);
  }
  return refs;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(repo: Repo, caps: string, includeHead: boolean): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (includeHead && headOid !== undefined) {
      parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    } else if (includeHead) {
      parts.push(encodePktLine(`${ZERO_OID} HEAD\0${caps}\n`));
    } else {
      const first = refs[0];
      parts.push(encodePktLine(`${first.oid} ${first.name}\0${caps}\n`));
      if (first.peeled !== undefined) parts.push(encodePktLine(`${first.peeled} ${first.name}^{}\n`));
      for (const ref of refs.slice(1)) {
        parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
        if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine('agent=forge/1.0\n'),
    pktFlush(),
  ]);
}

function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (prefixes.length === 0 && symrefs) {
    if (headOid !== undefined) parts.push(encodePktLine(`${headOid} HEAD symref-target:${headTarget(repo)}\n`));
    else if (unborn) parts.push(encodePktLine(`unborn HEAD symref-target:${headTarget(repo)}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const raw = await readBody(req);
  let packets;
  try {
    packets = decodePktLines(raw).packets;
  } catch {
    return sendRaw(res, 400, Buffer.from('bad request\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  const lines: string[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'flush') sawFlush = true;
  }
  if (lines.length === 0 || !sawFlush) {
    return sendRaw(res, 400, Buffer.from('bad request\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  const first = lines[0].replace(/\n$/, '');
  if (first.startsWith('command=ls-refs')) {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    return sendRaw(res, 200, lsRefsResponse(repo, prefixes, peel, symrefs, unborn), 'application/x-git-upload-pack-result');
  }
  if (first.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let inArgs = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!inArgs) continue;
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    }
    const selected = store.selectFetch(repo, wants, haves, shallow, depth);
    const pack = writePack(selected.objects);
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktDelim());
    if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of selected.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of selected.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(encodePktLine('packfile\n'), sidebandPack(pack), pktFlush());
    return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  // v0 fetch: want/have/shallow/deepen lines, two sections split by a flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  const selected = store.selectFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(selected.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of selected.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack), pktFlush());
  return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const raw = await readBody(req);
  let packets;
  let packStart = 0;
  try {
    const decoded = decodePktLines(raw, 0, true);
    packets = decoded.packets;
    packStart = decoded.next;
  } catch {
    return sendRaw(res, 400, Buffer.from('bad request\n', 'utf8'), 'text/plain; charset=utf-8');
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const commandPart = nul >= 0 ? line.slice(0, nul) : line;
    const fields = commandPart.split(' ');
    if (fields.length < 3) continue;
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  const packBytes = raw.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      store.ingestPack(repo, Buffer.from(packBytes));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} ref not found\n`);
        } else if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else if (repo.objects.get(command.newOid) === undefined) {
          reportLines.push(`ng ${command.ref} missing object\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
      } else {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} ref not found\n`);
        } else if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else if (repo.objects.get(command.newOid) === undefined) {
          reportLines.push(`ng ${command.ref} missing object\n`);
        } else if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => encodePktLine(line)));
  const body = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
  return sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = segmentsOf(path);
  // /{owner}/{repo}.git/...
  if (segments.length < 2 || !segments[1].endsWith('.git')) return sendError(res, 404, 'Not Found');
  const owner = segments[0];
  const repoName = segments[1].slice(0, -4);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const rest = segments.slice(2);
  if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
    const service = queryOf(url).get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        return sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      }
      const body = Buffer.concat([encodePktLine('# service=git-upload-pack\n'), pktFlush(), v0Advertisement(repo, UPLOAD_V0_CAPS, true)]);
      return sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      const body = Buffer.concat([encodePktLine('# service=git-receive-pack\n'), pktFlush(), v0Advertisement(repo, RECEIVE_CAPS, true)]);
      return sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
    }
    return sendError(res, 404, 'Not Found');
  }
  if (method === 'POST' && rest[0] === 'git-upload-pack' && rest.length === 1) {
    return handleGitUploadPack(req, res, repo);
  }
  if (method === 'POST' && rest[0] === 'git-receive-pack' && rest.length === 1) {
    return handleGitReceivePack(req, res, repo);
  }
  return sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://entry');
        } catch {
          url = new URL('/', 'http://entry');
        }
        const path = pathOf(url);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          const outcome = handleMcp(store, raw.toString('utf8'), isAuthorized(req));
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': store.nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!isAuthorized(req)) {
            sendError(res, 401, 'Unauthorized: a valid bearer token is required');
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if ('error' in parsed) {
            sendJson(res, 400, { data: null, errors: [{ message: parsed.error }] });
            return;
          }
          if (Array.isArray(parsed.value)) {
            const results = executeGraphQLBatch(store, parsed.value);
            sendJson(res, 200, results);
            return;
          }
          const result = executeGraphQL(store, parsed.value);
          sendJson(res, 200, result);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            sendError(res, 401, 'Unauthorized: a valid bearer token is required');
            return;
          }
          await handleRest(req, res, url);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const segments = segmentsOf(path);
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          if (!isAuthorized(req)) {
            sendError(res, 401, 'Unauthorized: a valid bearer token is required');
            return;
          }
          await handleGit(req, res, path, url);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : String(err));
        } else {
          res.destroy();
        }
      }
    })();
  });
}
