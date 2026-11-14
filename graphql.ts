// SPDX-License-Identifier: MIT
// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server send.
// No library: a tokenizer + recursive-descent parser for the subset in use, then resolvers over
// the store. Unknown fields are reported as GraphQL errors (HTTP 200), never as HTTP errors.

import {
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  VIEWER_LOGIN,
  VIEWER_ID,
} from './store.ts';

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

// --------------------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(input[i + (ch === '-' ? 1 : 0)] ?? '')) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'int', value: Number.parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { type: string }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    const variables: Record<string, { type: string }> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        variables[varName] = { type: this.parseType() };
        if (this.acceptPunct('=')) this.parseValue();
      }
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private parseType(): string {
    let type = '';
    if (this.acceptPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next?.kind === 'name') {
        // A named fragment spread: unsupported; treat its name as a condition-less spread and
        // skip its selection set if one follows (fragments are not used by the suite's documents).
        this.next();
      }
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'private', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'closedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'url', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'createdAt', 'author'],
  Ref: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
};

function fieldsOf(typeName: string): Array<{ name: string }> {
  return (TYPE_FIELDS[typeName] ?? []).map((name) => ({ name }));
}

// --------------------------------------------------------------------------- executor

interface Ctx {
  store: Store;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}
function commentGlobalId(repo: Repo, commentId: number): string {
  return globalId('IssueComment', repo.id, commentId);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}
function indexFromCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
  return -1;
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  execute(operation: Operation, variables: Record<string, unknown>): GraphQLResult {
    this.errors = [];
    const data: Record<string, unknown> = {};
    for (const selection of operation.selection) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === null || selection.typeCondition === 'Query') {
          this.resolveSelections('Query', null, selection.selection, variables, data);
        }
        continue;
      }
      this.resolveField('Query', null, selection, variables, data);
    }
    const result: GraphQLResult = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private resolveSelections(
    typeName: string,
    source: unknown,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
    out: Record<string, unknown>,
  ): void {
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === null || selection.typeCondition === typeName) {
          this.resolveSelections(typeName, source, selection.selection, variables, out);
        }
        continue;
      }
      this.resolveField(typeName, source, selection, variables, out);
    }
  }

  private resolveField(
    typeName: string,
    source: unknown,
    field: FieldNode,
    variables: Record<string, unknown>,
    out: Record<string, unknown>,
  ): void {
    const key = field.alias ?? field.name;
    const allowed = TYPE_FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      return;
    }
    const value = this.fieldValue(typeName, source, field, variables);
    if (field.selection.length === 0 || value === null || value === undefined) {
      out[key] = value ?? null;
      return;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        const itemType = this.typeOf(item);
        const child: Record<string, unknown> = {};
        if (itemType !== null) this.resolveSelections(itemType, item, field.selection, variables, child);
        return child;
      });
      return;
    }
    if (typeof value === 'object') {
      const childType = this.typeOf(value);
      if (childType === null) {
        out[key] = value;
        return;
      }
      const child: Record<string, unknown> = {};
      this.resolveSelections(childType, value, field.selection, variables, child);
      out[key] = child;
      return;
    }
    out[key] = value;
  }

  /** The GraphQL type name of a resolved object (by its __typename marker). */
  private typeOf(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const marker = (value as { __typename?: unknown }).__typename;
    return typeof marker === 'string' ? marker : null;
  }

  private fieldValue(
    typeName: string,
    source: unknown,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): unknown {
    const store = this.ctx.store;
    switch (typeName) {
      case 'Query': {
        if (field.name === 'viewer') {
          return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' };
        }
        if (field.name === 'repository') {
          const owner = argValue(field, 'owner', variables);
          const name = argValue(field, 'name', variables);
          if (typeof owner !== 'string' || typeof name !== 'string') return null;
          const repo = store.getRepo(owner, name);
          return repo === undefined ? null : this.repositoryObject(repo);
        }
        if (field.name === 'node') {
          const id = argValue(field, 'id', variables);
          if (typeof id !== 'string') return null;
          const decoded = decodeGlobalId(id);
          if (decoded === null) return null;
          if (decoded.kind === 'Repository') {
            const repoId = Number(decoded.parts[0]);
            for (const repo of store.viewerRepos()) if (repo.id === repoId) return this.repositoryObject(repo);
            return null;
          }
          if (decoded.kind === 'Issue') {
            const repoId = Number(decoded.parts[0]);
            const number = Number(decoded.parts[1]);
            for (const repo of store.viewerRepos()) {
              if (repo.id !== repoId) continue;
              const issue = repo.issues.get(number);
              if (issue) return this.issueObject(repo, issue);
            }
            return null;
          }
          if (decoded.kind === 'PullRequest') {
            const repoId = Number(decoded.parts[0]);
            const number = Number(decoded.parts[1]);
            for (const repo of store.viewerRepos()) {
              if (repo.id !== repoId) continue;
              const pull = repo.pulls.get(number);
              if (pull) return this.pullObject(repo, pull);
            }
            return null;
          }
          return null;
        }
        if (field.name === '__type') {
          const name = argValue(field, 'name', variables);
          if (typeof name !== 'string') return null;
          if (TYPE_FIELDS[name] === undefined && TYPE_ENUM_VALUES[name] === undefined) return null;
          return {
            __typename: '__Type',
            name,
            fields: TYPE_FIELDS[name] === undefined ? null : fieldsOf(name),
            enumValues: TYPE_ENUM_VALUES[name] === undefined ? null : TYPE_ENUM_VALUES[name].map((value) => ({ name: value })),
          };
        }
        if (field.name === '__schema') return null;
        return null;
      }
      case 'Repository': {
        const repo = (source as { __repo: Repo }).__repo;
        switch (field.name) {
          case 'id': return repoGlobalId(repo);
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
          case 'owner': return { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' };
          case 'defaultBranchRef': return { __typename: 'Ref', name: repo.defaultBranch };
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
          case 'description': return repo.description;
          case 'private': return repo.isPrivate;
          case 'createdAt': return repo.createdAt;
          case 'updatedAt': return repo.updatedAt;
          case 'issue': {
            const number = argValue(field, 'number', variables);
            if (typeof number !== 'number') return null;
            const issue = repo.issues.get(number);
            return issue === undefined ? null : this.issueObject(repo, issue);
          }
          case 'issues': return this.issuesConnection(repo, field, variables);
          case 'pullRequests': return this.pullsConnection(repo, field, variables);
          case 'pullRequest': {
            const number = argValue(field, 'number', variables);
            if (typeof number !== 'number') return null;
            const pull = repo.pulls.get(number);
            return pull === undefined ? null : this.pullObject(repo, pull);
          }
          default: return null;
        }
      }
      case 'Issue': {
        const { __repo: repo, __issue: issue } = (source as { __repo: Repo; __issue: Issue });
        switch (field.name) {
          case 'id': return issueGlobalId(repo, issue);
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'body': return issue.body;
          case 'state': return issueState(issue);
          case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
          case 'createdAt': return issue.createdAt;
          case 'updatedAt': return issue.updatedAt;
          case 'closedAt': return issue.closedAt;
          case 'author': return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
          default: return null;
        }
      }
      case 'PullRequest': {
        const { __repo: repo, __pull: pull } = (source as { __repo: Repo; __pull: Pull });
        switch (field.name) {
          case 'id': return pullGlobalId(repo, pull);
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': return pull.body;
          case 'state': return pullState(pull);
          case 'merged': return pull.merged;
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'mergeable': return store.pullMergeable(repo, pull);
          case 'mergedAt': return pull.mergedAt;
          case 'mergeCommit': return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
          case 'headRef': return { __typename: 'Ref', name: pull.headRef };
          case 'baseRef': return { __typename: 'Ref', name: pull.baseRef };
          case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
          case 'createdAt': return pull.createdAt;
          case 'updatedAt': return pull.updatedAt;
          case 'author': return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
          case 'files': {
            const first = argValue(field, 'first', variables);
            const files = store.pullFiles(repo, pull);
            const nodes = files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status }));
            const limited = typeof first === 'number' ? nodes.slice(0, first) : nodes;
            return { __typename: 'PullRequestChangedFileConnection', nodes: limited, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
          }
          default: return null;
        }
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection': {
        const conn = source as { nodes?: unknown[]; pageInfo?: unknown; totalCount?: number };
        switch (field.name) {
          case 'nodes': return conn.nodes ?? [];
          case 'pageInfo': return conn.pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
          case 'totalCount': return conn.totalCount ?? (conn.nodes?.length ?? 0);
          case 'edges': return (conn.nodes ?? []).map((node) => ({ __typename: 'Edge', node, cursor: null }));
          default: return null;
        }
      }
      case 'PageInfo': {
        const info = source as { hasNextPage?: boolean; hasPreviousPage?: boolean; startCursor?: string | null; endCursor?: string | null };
        switch (field.name) {
          case 'hasNextPage': return info.hasNextPage ?? false;
          case 'hasPreviousPage': return info.hasPreviousPage ?? false;
          case 'startCursor': return info.startCursor ?? null;
          case 'endCursor': return info.endCursor ?? null;
          default: return null;
        }
      }
      case 'PullRequestChangedFile': {
        const file = source as { path?: string; additions?: number; deletions?: number; changeType?: string };
        switch (field.name) {
          case 'path': return file.path ?? null;
          case 'additions': return file.additions ?? 0;
          case 'deletions': return file.deletions ?? 0;
          case 'changeType': return file.changeType ?? null;
          default: return null;
        }
      }
      case 'User': {
        const user = source as { login?: string; id?: number; name?: string; email?: string };
        switch (field.name) {
          case 'login': return user.login ?? null;
          case 'id': return user.id ?? null;
          case 'name': return user.name ?? null;
          case 'email': return user.email ?? null;
          default: return null;
        }
      }
      case 'Ref': {
        const ref = source as { name?: string };
        return field.name === 'name' ? ref.name ?? null : null;
      }
      case '__Type': {
        const type = source as { name?: string; fields?: Array<{ name: string }> | null; enumValues?: Array<{ name: string }> | null };
        switch (field.name) {
          case 'name': return type.name ?? null;
          case 'kind': return type.enumValues !== null && type.enumValues !== undefined ? 'ENUM' : 'OBJECT';
          case 'fields': {
            const list = type.fields ?? [];
            return list.map((entry) => ({ __typename: '__Field', name: entry.name, description: null, type: null, args: [] }));
          }
          case 'enumValues': {
            const list = type.enumValues ?? [];
            return list.map((entry) => ({ __typename: '__EnumValue', name: entry.name, description: null }));
          }
          case 'description': return null;
          default: return null;
        }
      }
      case '__Field':
      case '__EnumValue': {
        const entry = source as { name?: string; description?: string | null };
        if (field.name === 'name') return entry.name ?? null;
        if (field.name === 'description') return entry.description ?? null;
        return null;
      }
      case 'CommentEdge': {
        const edge = source as { node?: unknown; cursor?: string | null };
        if (field.name === 'node') return edge.node ?? null;
        if (field.name === 'cursor') return edge.cursor ?? null;
        return null;
      }
      case 'Comment': {
        const comment = source as { id?: string; body?: string; createdAt?: string };
        switch (field.name) {
          case 'id': return comment.id ?? null;
          case 'body': return comment.body ?? null;
          case 'createdAt': return comment.createdAt ?? null;
          case 'author': return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
          default: return null;
        }
      }
      case 'Edge': {
        const edge = source as { node?: unknown; cursor?: string | null };
        if (field.name === 'node') return edge.node ?? null;
        if (field.name === 'cursor') return edge.cursor ?? null;
        return null;
      }
      default:
        return null;
    }
  }

  private repositoryObject(repo: Repo): Record<string, unknown> {
    return { __typename: 'Repository', __repo: repo };
  }
  private issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return { __typename: 'Issue', __repo: repo, __issue: issue };
  }
  private pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
    return { __typename: 'PullRequest', __repo: repo, __pull: pull };
  }

  private issuesConnection(repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const first = argValue(field, 'first', variables);
    const after = argValue(field, 'after', variables);
    const states = argValue(field, 'states', variables);
    const orderBy = argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
    let issues = [...repo.issues.values()];
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      issues = issues.filter((issue) => wanted.has(issueState(issue)));
    }
    const direction = orderBy?.direction === 'ASC' ? 1 : -1;
    issues.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
    const start = indexFromCursor(typeof after === 'string' ? after : null) + 1;
    const page = issues.slice(start);
    const limit = typeof first === 'number' ? first : page.length;
    const nodes = page.slice(0, limit).map((issue) => this.issueObject(repo, issue));
    const hasNextPage = page.length > limit;
    const endCursor = nodes.length > 0 ? cursorFor(start + nodes.length - 1) : null;
    return {
      __typename: 'IssueConnection',
      nodes,
      pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor: nodes.length > 0 ? cursorFor(start) : null, endCursor },
      totalCount: issues.length,
    };
  }

  private pullsConnection(repo: Repo, field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const first = argValue(field, 'first', variables);
    const after = argValue(field, 'after', variables);
    const states = argValue(field, 'states', variables);
    let pulls = [...repo.pulls.values()];
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
    }
    pulls.sort((a, b) => b.seq - a.seq);
    const start = indexFromCursor(typeof after === 'string' ? after : null) + 1;
    const page = pulls.slice(start);
    const limit = typeof first === 'number' ? first : page.length;
    const nodes = page.slice(0, limit).map((pull) => this.pullObject(repo, pull));
    const hasNextPage = page.length > limit;
    const endCursor = nodes.length > 0 ? cursorFor(start + nodes.length - 1) : null;
    return {
      __typename: 'PullRequestConnection',
      nodes,
      pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor: nodes.length > 0 ? cursorFor(start) : null, endCursor },
      totalCount: pulls.length,
    };
  }

  // ---------------------------------------------------------------- mutations

  executeMutation(operation: Operation, variables: Record<string, unknown>): GraphQLResult {
    this.errors = [];
    const data: Record<string, unknown> = {};
    for (const selection of operation.selection) {
      if (selection.kind !== 'field') continue;
      this.resolveMutation(selection, variables, data);
    }
    const result: GraphQLResult = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private resolveMutation(field: FieldNode, variables: Record<string, unknown>, out: Record<string, unknown>): void {
    const key = field.alias ?? field.name;
    const store = this.ctx.store;
    const input = argValue(field, 'input', variables) as Record<string, unknown> | undefined;
    const inputObj: Record<string, unknown> = input !== undefined && typeof input === 'object' && input !== null ? input : {};
    let value: Record<string, unknown> | null = null;
    if (field.name === 'createIssue') {
      const repoId = typeof inputObj.repositoryId === 'string' ? decodeGlobalId(inputObj.repositoryId) : null;
      const repo = repoId?.kind === 'Repository' ? store.viewerRepos().find((candidate) => candidate.id === Number(repoId.parts[0])) : undefined;
      if (repo === undefined || typeof inputObj.title !== 'string') {
        this.errors.push({ message: 'createIssue: unknown repository' });
      } else {
        const issue = store.createIssue(repo, inputObj.title, typeof inputObj.body === 'string' ? inputObj.body : '', []);
        value = { __typename: 'CreateIssuePayload', issue: this.issueObject(repo, issue) };
      }
    } else if (field.name === 'closeIssue') {
      const decoded = typeof inputObj.issueId === 'string' ? decodeGlobalId(inputObj.issueId) : null;
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = store.viewerRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (found === null) {
        this.errors.push({ message: 'closeIssue: unknown issue' });
      } else {
        found.issue.state = 'closed';
        found.issue.closedAt = found.issue.updatedAt;
        value = { __typename: 'CloseIssuePayload', issue: this.issueObject(found.repo, found.issue) };
      }
    } else if (field.name === 'createPullRequest') {
      const repoId = typeof inputObj.repositoryId === 'string' ? decodeGlobalId(inputObj.repositoryId) : null;
      const repo = repoId?.kind === 'Repository' ? store.viewerRepos().find((candidate) => candidate.id === Number(repoId.parts[0])) : undefined;
      const head = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
      const base = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : '';
      const title = typeof inputObj.title === 'string' ? inputObj.title : '';
      if (repo === undefined || head === '' || base === '' || title === '') {
        this.errors.push({ message: 'createPullRequest: unknown repository or missing refs' });
      } else {
        const pull = store.createPull(repo, title, typeof inputObj.body === 'string' ? inputObj.body : '', head, base);
        if (pull === null) {
          this.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        } else {
          value = { __typename: 'CreatePullRequestPayload', pullRequest: this.pullObject(repo, pull) };
        }
      }
    } else if (field.name === 'mergePullRequest') {
      const decoded = typeof inputObj.pullRequestId === 'string' ? decodeGlobalId(inputObj.pullRequestId) : null;
      let found: { repo: Repo; pull: Pull } | null = null;
      if (decoded?.kind === 'PullRequest') {
        const repo = store.viewerRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        if (repo && pull) found = { repo, pull };
      }
      if (found === null) {
        this.errors.push({ message: 'mergePullRequest: unknown pull request' });
      } else {
        const merged = store.mergePull(found.repo, found.pull);
        if (merged === null) {
          this.errors.push({ message: 'mergePullRequest: the pull request is conflicted' });
        } else {
          value = { __typename: 'MergePullRequestPayload', pullRequest: this.pullObject(found.repo, found.pull) };
        }
      }
    } else if (field.name === 'addComment') {
      const decoded = typeof inputObj.subjectId === 'string' ? decodeGlobalId(inputObj.subjectId) : null;
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded?.kind === 'Issue') {
        const repo = store.viewerRepos().find((candidate) => candidate.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (repo && issue) found = { repo, issue };
      }
      if (found === null || typeof inputObj.body !== 'string') {
        this.errors.push({ message: 'addComment: unknown subject' });
      } else {
        const commentId = found.repo.nextCommentId++;
        const comment: { id: number; body: string; createdAt: string } = { id: commentId, body: inputObj.body, createdAt: found.issue.createdAt };
        found.issue.comments.push(comment);
        value = {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: { __typename: 'Comment', id: commentGlobalId(found.repo, commentId), body: comment.body, createdAt: comment.createdAt },
            cursor: null,
          },
        };
      }
    } else {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      out[key] = null;
      return;
    }
    if (value === null) {
      out[key] = null;
      return;
    }
    if (field.selection.length === 0) {
      out[key] = value;
      return;
    }
    const child: Record<string, unknown> = {};
    const payloadType = (value as { __typename: string }).__typename;
    for (const selection of field.selection) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === null || selection.typeCondition === payloadType) {
          this.resolveSelections(payloadType, value, selection.selection, variables, child);
        }
        continue;
      }
      // Payload fields are objects (issue / pullRequest / commentEdge): resolve their selections.
      const payloadValue = (value as Record<string, unknown>)[selection.name];
      const aliasKey = selection.alias ?? selection.name;
      if (payloadValue === undefined || payloadValue === null) {
        child[aliasKey] = null;
        continue;
      }
      if (typeof payloadValue === 'object' && !Array.isArray(payloadValue)) {
        const childType = this.typeOf(payloadValue);
        if (childType !== null && selection.selection.length > 0) {
          const grandchild: Record<string, unknown> = {};
          this.resolveSelections(childType, payloadValue, selection.selection, variables, grandchild);
          child[aliasKey] = grandchild;
        } else {
          child[aliasKey] = payloadValue;
        }
      } else {
        child[aliasKey] = payloadValue;
      }
    }
    out[key] = child;
  }
}

/** Execute one GraphQL operation body ({query, variables}) against the store. */
export function executeGraphQL(store: Store, body: unknown): GraphQLResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'the request body must be a JSON object with query and variables' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'no query was provided' }] };
  }
  const variables = (record.variables !== undefined && typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const executor = new Executor({ store });
  if (operation.type === 'mutation') return executor.executeMutation(operation, variables);
  return executor.execute(operation, variables);
}

/** Execute a batched body (an array of operations), in order. */
export function executeGraphQLBatch(store: Store, bodies: unknown[]): GraphQLResult[] {
  return bodies.map((body) => executeGraphQL(store, body));
}
