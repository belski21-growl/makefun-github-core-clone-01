# github-core-clone-01 — a standalone GitHub-compatible forge

One Node 22 process (stdlib only, no git binary, no network at runtime) that speaks
enough of GitHub to pass the competition suite: git smart HTTP, REST v3, GraphQL v4
and MCP, over a single in-memory store.

## Layout

| File | What it owns |
| --- | --- |
| `main.ts` | The entry lifecycle (starter, unchanged): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET /done`, exit 0. |
| `app.ts` | Hand-rolled HTTP/1.1 over raw TCP (`node:net`, no `node:http`): request parsing, keep-alive, chunked bodies; routing, bearer auth, `X-GitHub-Request-Id`, REST v3 handlers, GraphQL/MCP dispatch and the git smart-HTTP handlers (v2/v0 advertisement, ls-refs, fetch, receive-pack). Response/pack/advert caches live here. |
| `gitproto.ts` | pkt-line codec, SHA-1 object model (commit/tree/tag/blob), pack read (plain + OFS/REF deltas) and write (plain objects, single-buffer build with incremental trailer hash), sideband framing (single allocation). |
| `store.ts` | The in-memory store: repos, objects, refs, issues/PRs (one shared number counter), contents commits, squash merges with conflict detection, fetch selection (depth-limited, shallow/unshallow), global ids. Issues carry a `jsonRev` generation (cached serialisation), repos a `packGen` (cached fetch packs) and a `refsGen` (cached advertisements). |
| `graphql.ts` | A small GraphQL tokenizer + recursive-descent parser and executor: `repository`, `viewer`, `node(id:)`, `__type`, issue/PR connections with cursor pagination, and the five mutations (create/close issue, create/merge pull request, add comment). |
| `mcp.ts` | MCP over Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` for six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). Issue views are served pre-serialised from a `WeakMap` cache keyed by issue + `jsonRev`. |

## Behaviour notes

- Auth: every API and git call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
  (the same token the environment uses). A repo under another owner is a 404, never a 403.
- Determinism: no wall clock or randomness anywhere in a response body — every
  created timestamp is the fixed `2025-01-01T00:00:00Z` (commit epoch 1700000000).
  (The `Date` response header is the one exception: it is the live clock, exactly
  as `node:http` sent it before the raw-TCP transport.)
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

## Practice results (round 2, 19 Nov 2026, fresh kit KIT_LEVEL 20, Node 24)

- Feature checks: **120/120** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, graphql 20/20, mcp 15/15 (four full-kit runs, all 120/120).
- Benchmark (same runs, `--perf`, production T_refs push 1641 / clone 267 /
  read 2760 / write 349 ms): perf **103–178/200**, median ≈111 — push p50
  493–1063 ms, clone p50 61–296 ms, read p50 1320–3876 ms, write p50 126–481 ms.
  Wall times on this shared-CPU VM swing hard with host load (the same build
  scored 103 and 178 twenty minutes apart), so the stable comparison is the
  interleaved A/B against round 1 in the same load window: round 2 beats round 1
  on every workload in both pairs (push −39%/−54%, clone −26%/−86%,
  read −20%/−32%, write −60%/−40%). Server CPU per operation, the load-independent
  metric: read 740 → 580 ms/10k ops (−22%), write 210 → 120 ms/1k ops (−43%).
- Round 1 scored **923** on the server (perf ≈123, median). The round-2 changes
  (pre-serialised issue JSON, fetch-pack + advertisement caches, single-buffer
  pack build, fast router without `new URL()`, hand-rolled HTTP/1.1 over raw TCP)
  are all server-side time cuts, so the server score should rise by roughly the
  per-workload log gains — low-to-mid 940s, around the 952 top-60 cutoff.

## License

MIT — see `LICENSE`.
