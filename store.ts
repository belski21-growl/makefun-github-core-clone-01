// SPDX-License-Identifier: MIT
// store.ts — the forge's in-memory store: repositories, git objects, refs, issues, pull requests.
// Everything is deterministic: no wall clock, no randomness. Timestamps are fixed constants so a
// live pass and its replay produce identical bytes.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';
import { ZERO_OID } from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** Fixed commit time (2023-11-14T22:13:20Z): every contents/merge commit uses it, never Date.now(). */
export const FIXED_EPOCH = 1700000000;
/** Fixed ISO timestamp for every created_at / updated_at / merged_at. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export function viewerIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  nextObjectSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRestId = 1;
  private nextRequest = 0;

  nextRequestId(): string {
    this.nextRequest += 1;
    return `req-${String(this.nextRequest).padStart(6, '0')}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextObjectSeq: 1,
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  nextId(): number {
    return this.nextRestId++;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  objectOf(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store every object from a received pack. Returns the oids. */
  ingestPack(repo: Repo, pack: Buffer): string[] {
    const read = readPack(pack, (oid) => repo.objects.get(oid));
    const oids: string[] = [];
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      oids.push(oid);
    }
    return oids;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a ref name, a branch name or a raw oid to a commit oid. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (!object) return undefined;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return parseTag(object.data).object;
      return undefined;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree (by root oid) to path -> {oid, mode}. */
  flattenTree(repo: Repo, rootOid: string | undefined): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (rootOid === undefined) return out;
    const walk = (treeOid: string, prefix: string): void => {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(rootOid, '');
    return out;
  }

  /** The tree entry at `path` under a root tree oid, or null. Directories report mode 40000. */
  treeEntryAt(repo: Repo, rootOid: string | undefined, path: string): { oid: string; mode: string } | null {
    if (rootOid === undefined) return null;
    const parts = path.split('/').filter((part) => part !== '');
    let current = rootOid;
    for (let index = 0; index < parts.length; index += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
      if (!entry) return null;
      if (index === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** List a directory's entries under a root tree oid; null when the path is not a directory. */
  treeDirAt(repo: Repo, rootOid: string | undefined, path: string): TreeEntry[] | null {
    if (rootOid === undefined) return null;
    if (path === '' || path === '/') {
      const object = repo.objects.get(rootOid);
      return object?.type === 'tree' ? parseTree(object.data) : null;
    }
    const entry = this.treeEntryAt(repo, rootOid, path);
    if (!entry || entry.mode !== '40000') return null;
    const object = repo.objects.get(entry.oid);
    return object?.type === 'tree' ? parseTree(object.data) : null;
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null), rebuilding parent trees.
   * `rootOid` may be undefined for an unborn tree.
   */
  setTreePath(repo: Repo, rootOid: string | undefined, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | undefined, depth: number): string | undefined => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== undefined) {
        const object = repo.objects.get(treeOid);
        if (object?.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = parts[depth];
      if (depth === parts.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const next = build(child?.mode === '40000' ? child.oid : undefined, depth + 1);
        if (next === undefined) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      if (entries.size === 0) return undefined;
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    const root = build(rootOid, 0);
    if (root === undefined) {
      // An emptied tree: git keeps an empty tree object.
      return this.putObject(repo, 'tree', buildTree([]));
    }
    return root;
  }

  // ---------------------------------------------------------------- contents commits

  /** The root tree oid of a branch tip (undefined when unborn). */
  branchTree(repo: Repo, branch: string): string | undefined {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return undefined;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /**
   * Commit a contents change on `branch` (creating the branch at the commit when unborn).
   * Returns the new commit sha and the blob sha (null on delete).
   */
  commitContents(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const rootTree = tip === undefined ? undefined : this.branchTree(repo, branch);
    let blobSha: string | null = null;
    if (content !== null) blobSha = this.putObject(repo, 'blob', content);
    const newTree = this.setTreePath(repo, rootTree, path, blobSha);
    const parents = tip === undefined ? [] : [tip];
    const commitData = buildCommit({
      tree: newTree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: viewerIdentity(),
      committer: viewerIdentity(),
      timestamp: FIXED_EPOCH,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: number,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      closedAt: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: number,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Paths that differ between two trees, with their blob oids (undefined = absent). */
  diffTrees(
    repo: Repo,
    baseTree: string | undefined,
    headTree: string | undefined,
  ): Array<{ path: string; baseOid?: string; headOid?: string }> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; baseOid?: string; headOid?: string }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b?.oid === h?.oid) continue;
      out.push({ path, baseOid: b?.oid, headOid: h?.oid });
    }
    return out;
  }

  /** Line counts for a changed file: additions / deletions by multiset line difference. */
  lineCounts(repo: Repo, baseOid: string | undefined, headOid: string | undefined): { additions: number; deletions: number } {
    const linesOf = (oid: string | undefined): Map<string, number> => {
      const counts = new Map<string, number>();
      if (oid === undefined) return counts;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'blob') return counts;
      for (const line of object.data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const base = linesOf(baseOid);
    const head = linesOf(headOid);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of head) additions += Math.max(0, count - (base.get(line) ?? 0));
    for (const [line, count] of base) deletions += Math.max(0, count - (head.get(line) ?? 0));
    return { additions, deletions };
  }

  /** A pull request's changed files, with status and line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTree = this.branchTree(repo, pull.headRef) ?? this.commitTree(repo, headTip);
    const baseTree = this.branchTree(repo, pull.baseRef) ?? this.commitTree(repo, baseTip);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const change of this.diffTrees(repo, baseTree, headTree)) {
      const status = change.baseOid === undefined ? 'added' : change.headOid === undefined ? 'removed' : 'modified';
      const counts = this.lineCounts(repo, change.baseOid, change.headOid);
      out.push({ filename: change.path, status, additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
    return out;
  }

  commitTree(repo: Repo, commitOid: string | undefined): string | undefined {
    if (commitOid === undefined) return undefined;
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /**
   * Squash-merge a pull request. Returns the merge commit sha, or null when the pull is conflicted.
   * Conflict: a path changed on both sides of the merge-base with different results.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const base = mergeBase(headTip, baseTip, lookup);
    const baseTree = base === null ? undefined : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const currentBaseTree = this.commitTree(repo, baseTip);
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const baseChanges = this.diffTrees(repo, baseTree, currentBaseTree);
    const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseByPath.get(change.path);
      if (!other) continue;
      if (other.headOid !== change.headOid) return null;
    }
    const commitData = buildCommit({
      tree: headTree ?? this.putObject(repo, 'tree', buildTree([])),
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})\n`,
      author: viewerIdentity(),
      committer: viewerIdentity(),
      timestamp: FIXED_EPOCH,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = FIXED_ISO;
    return mergeSha;
  }

  /** MERGEABLE / CONFLICTING for a pull request (same rule as mergePull, without merging). */
  pullMergeable(repo: Repo, pull: Pull): string {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const base = mergeBase(headTip, baseTip, lookup);
    const baseTree = base === null ? undefined : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const currentBaseTree = this.commitTree(repo, baseTip);
    const headChanges = this.diffTrees(repo, baseTree, headTree);
    const baseByPath = new Map(this.diffTrees(repo, baseTree, currentBaseTree).map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseByPath.get(change.path);
      if (other && other.headOid !== change.headOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  // ---------------------------------------------------------------- fetch selection

  /**
   * The objects a fetch must send: wanted closure (depth-limited) minus what the client holds.
   * `held` is the closure of haves, stopping at the client's shallow boundaries.
   */
  selectFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallowBoundaries: readonly string[],
    depth: number | undefined,
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const shallowSet = new Set(shallowBoundaries);

    // What the client already holds: closure of haves, not crossing shallow boundaries.
    const held = new Set<string>();
    {
      const queue = [...haves];
      while (queue.length) {
        const oid = queue.pop()!;
        if (held.has(oid)) continue;
        const object = lookup(oid);
        if (!object) continue;
        held.add(oid);
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          const treeObjects = collectReachable([commit.tree], lookup);
          for (const treeOid of treeObjects) held.add(treeOid);
          if (shallowSet.has(oid)) continue;
          for (const parent of commit.parents) queue.push(parent);
        } else if (object.type === 'tag') {
          queue.push(parseTag(object.data).object);
        } else if (object.type === 'tree') {
          for (const treeOid of collectReachable([oid], lookup)) held.add(treeOid);
        }
      }
    }

    // What the client wants: closure of wants, commits limited by depth.
    const wanted = new Set<string>();
    const commitDepth = new Map<string, number>();
    {
      const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
      while (queue.length) {
        const { oid, depth: at } = queue.pop()!;
        const object = lookup(oid);
        if (!object) continue;
        if (object.type === 'commit') {
          if (depth !== undefined && at >= depth) continue;
          if (wanted.has(oid)) {
            if ((commitDepth.get(oid) ?? Infinity) <= at) continue;
          }
          wanted.add(oid);
          commitDepth.set(oid, at);
          const commit = parseCommit(object.data);
          for (const treeOid of collectReachable([commit.tree], lookup)) wanted.add(treeOid);
          for (const parent of commit.parents) queue.push({ oid: parent, depth: at + 1 });
        } else if (object.type === 'tag') {
          if (wanted.has(oid)) continue;
          wanted.add(oid);
          queue.push({ oid: parseTag(object.data).object, depth: at });
        } else {
          for (const treeOid of collectReachable([oid], lookup)) wanted.add(treeOid);
        }
      }
    }

    const send: GitObject[] = [];
    for (const oid of [...wanted].sort()) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object) send.push(object);
    }

    let shallow: string[] = [];
    let unshallow: string[] = [];
    if (depth !== undefined) {
      // New boundary: the deepest included commits (distance depth-1) that still have parents outside.
      for (const [oid, at] of commitDepth) {
        if (at !== depth - 1) continue;
        const object = lookup(oid);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.some((parent) => !wanted.has(parent))) shallow.push(oid);
      }
      // Old boundaries whose parents are now included are no longer shallow.
      for (const boundary of shallowBoundaries) {
        const object = lookup(boundary);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((parent) => wanted.has(parent))) unshallow.push(boundary);
        else if (wanted.has(boundary) && !shallow.includes(boundary)) shallow.push(boundary);
      }
      shallow = [...new Set(shallow)].sort();
      unshallow = [...new Set(unshallow)].sort();
    }
    return { objects: send, shallow, unshallow };
  }

  /** True when `newOid` is a fast-forward of `oldOid` (or old is the zero oid / unborn). */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    return isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid));
  }
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}
