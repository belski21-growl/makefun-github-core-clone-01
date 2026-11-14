// SPDX-License-Identifier: MIT
// mcp.ts — the Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0).
// Speaks the modern revision 2026-07-28 via server/discover, and the legacy handshake
// (initialize + notifications/initialized) for older clients. Plain JSON answers, no SSE.

import {
  type Repo,
  type Store,
  VIEWER_LOGIN,
} from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueJson(store: Store, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }>; comments: unknown[] }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    closed_at: null,
  };
}

/** Run one tool. Returns {ok, value} or {ok:false, message} for a tool execution error. */
export function runTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const def = MCP_TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { ok: false, message: `unknown tool ${name}` };
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, message: `missing required argument: ${required}` };
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return { ok: false, message: 'missing required argument: name' };
      if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) {
        return { ok: false, message: `repository ${VIEWER_LOGIN}/${repoNameArg} already exists` };
      }
      const repo = store.createRepo(
        repoNameArg,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, message: `repository ${owner}/${repoName} not found` };
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, message: `repository ${owner}/${repoName} not found` };
      const title = typeof args.title === 'string' ? args.title : '';
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { ok: true, value: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, message: `repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(store, repo, issue));
      return { ok: true, value: { issues } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, message: `repository ${owner}/${repoName} not found` };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = store.createPull(repo, title, body, head, base);
      if (pull === null) return { ok: false, message: `head or base branch does not exist in ${owner}/${repoName}` };
      return {
        ok: true,
        value: {
          id: pull.id,
          node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url'),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
          base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
          merged: false,
        },
      };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, message: `repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: false, message: `pull request ${number} not found` };
      if (pull.merged) return { ok: true, value: { number: pull.number, merged: true, sha: pull.mergeCommitSha, message: 'already merged' } };
      const sha = store.mergePull(repo, pull);
      if (sha === null) return { ok: false, message: `pull request ${number} is conflicted` };
      return { ok: true, value: { number: pull.number, merged: true, sha, message: `Merged pull request #${pull.number}` } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one POST /mcp body (already read as text). Returns {status, body} where body is null
 * for an empty 202 (a notification). `authorized` is whether the bearer token checked out.
 */
export function handleMcp(store: Store, bodyText: string, authorized: boolean): { status: number; body: Record<string, unknown> | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the request body is not valid JSON') };
  }
  if (!authorized) {
    const id = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonRpcRequest).id ?? null : null;
    return { status: 401, body: rpcError(id, -32000, 'Unauthorized: a valid bearer token is required') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = typeof request.params === 'object' && request.params !== null ? request.params : {};

  // Notifications (no id) are answered 202 with no body.
  if (request.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'discover',
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git smart HTTP.',
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      return {
        status: 200,
        body: rpcResult(id, {
          tools: MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }),
      };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const known = MCP_TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        return { status: 200, body: rpcError(id, -32601, `Method not found: no tool named ${toolName}`) };
      }
      const outcome = runTool(store, toolName, args);
      if (!outcome.ok) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: outcome.message }],
            structuredContent: { error: outcome.message },
            isError: true,
          }),
        };
      }
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
          isError: false,
        }),
      };
    }
    default: {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}
