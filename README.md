# github-core-clone-01 — a standalone GitHub-compatible forge

One Node 22 process (stdlib only, no git binary, no network at runtime) that speaks
enough of GitHub to pass the competition suite: git smart HTTP, REST v3, GraphQL v4
and MCP, over a single in-memory store.

## Layout

| File | What it owns |
| --- | --- |
| `main.ts` | The entry lifecycle (starter, unchanged): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET /done`, exit 0. |
| `app.ts` | The HTTP server: routing, bearer auth, `X-GitHub-Request-Id`, REST v3 handlers, GraphQL/MCP dispatch and the git smart-HTTP handlers (v2/v0 advertisement, ls-refs, fetch, receive-pack). |
| `gitproto.ts` | pkt-line codec, SHA-1 object model (commit/tree/tag/blob), pack read (plain + OFS/REF deltas) and write (plain objects), sideband framing. |
| `store.ts` | The in-memory store: repos, objects, refs, issues/PRs (one shared number counter), contents commits, squash merges with conflict detection, fetch selection (depth-limited, shallow/unshallow), global ids. |
| `graphql.ts` | A small GraphQL tokenizer + recursive-descent parser and executor: `repository`, `viewer`, `node(id:)`, `__type`, issue/PR connections with cursor pagination, and the five mutations (create/close issue, create/merge pull request, add comment). |
| `mcp.ts` | MCP over Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` for six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). |

## Behaviour notes

- Auth: every API and git call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
  (the same token the environment uses). A repo under another owner is a 404, never a 403.
- Determinism: no wall clock or randomness anywhere in a response — every created
  timestamp is the fixed `2025-01-01T00:00:00Z` (commit epoch 1700000000).
- Viewer: `adaiversen` (id 1000), the login the scenario seed derives.
- Git: protocol v2 when the client asks (`Git-Protocol: version=2`), v0 otherwise;
  receive-pack is v0 with `report-status`. Packs are plain (no deltas written) but
  deltas are understood on read. Shallow clones (`deepen`) and incremental fetches
  (`have`/`want`) are honoured.
- Contents commits are created server-side (viewer identity, fixed timestamp, parent
  = branch tip); a stale `sha` on PUT/DELETE is a 409.
- Pull requests: squash merge only; a path changed on both sides of the merge-base
  with different results is a conflict (405 on merge).

## Run locally

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:9 MAKEFUN_SHOP_TOKEN=test-token \
  node --experimental-strip-types main.ts
```

(`MAKEFUN_ENV_URL` must be set or `main.ts` exits 1; pointing it at a dead address
lets the server listen while `register` retries in the background.)

## Practice results (14 Nov 2026, local runner, Node 24)

- Feature checks: **120/120** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, graphql 20/20, mcp 15/15.
- Benchmark (same run, `--perf`): push p50 423 ms (29 pts), clone p50 169 ms
  (19 pts), read p50 1736 ms (13 pts), write p50 227 ms (13 pts) — **74/200** perf
  points on this shared-CPU VM. Push already beats the calibrated reference
  (T_ref 513 ms); read/write/clone trail the reference mostly on per-request
  overhead and host slowness (the calibration's own slow-window runs show the
  reference at read 1243–1562 ms, so the gap narrows on a quiet node).

## License

MIT — see `LICENSE`.
