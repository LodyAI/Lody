# @lody/e2ee-demo

Local-only E2EE reference app: two isolated browser clients, a loopback Node host,
and official `@loro-dev/sqlite-riverrun` on disk. Not product E2EE and not Lody
integration.

## Pinned inputs

| Input                       | Pin                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| workspace / branch          | this repo, `feat-e2ee-core`                                                                                                                     |
| `@lody/e2ee-core`           | workspace package (core busy-open / packed-consumer hunks from `1eb60249`)                                                                      |
| `@loro-dev/sqlite-riverrun` | npm `0.3.0` (catalog `0.2.0` has no `/append-cas`)                                                                                              |
| `@loro-dev/streams-crdt`    | `vendor/streams-crdt.tgz` SHA-256 `a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e` (continuationOffset; **not** npm `0.15.1`) |

Do not alias a sibling `loro-streams` source tree.

## Start / stop

From the repository root:

```sh
pnpm demo:e2ee
```

Equivalent: `pnpm --filter @lody/e2ee-demo start`.

`start` builds the React UI then serves it from the same loopback host as the
API. Two browser origins/contexts keep separate device keys.

Defaults: loopback `http://127.0.0.1:8788`, data directory `./.e2ee-demo-data`
(created next to the current working directory). SIGINT/SIGTERM close the host
and the Riverrun process this command started.

Flow: Connect (demo account picker) → Create space or paste genesis and Request
join → Approve → Deliver / receive epoch key → Write/read Loro and Flock →
Upload or bootstrap snapshot → Publish digest note → Compare (label is
`checked` only on `agree`; mismatch is `inconsistent`, never `checked`) →
Revoke / rotate → Export backup file and restore it in a new isolated context.

```sh
pnpm --filter @lody/e2ee-demo start -- --data-dir /abs/path --port 8788
```

## Acceptance

```sh
pnpm test:e2ee-demo
```

Equivalent: `pnpm --filter @lody/e2ee-demo test`.

This drives the shipped host over real HTTP, real Ed25519, and on-disk Riverrun.
Playwright isolated-context coverage: `pnpm --filter @lody/e2ee-demo test:browser`.

## Storage

- Riverrun SQLite: `$DATA_DIR/riverrun.sqlite` (ciphertext, ledger frames, CRDT bytes)
- Host metadata: `$DATA_DIR/host.sqlite` (demo credentials with original `expiresAt`, join requests)
- Snapshot admission: `$DATA_DIR/snapshots.sqlite`
- Client journals/keys stay in each client directory / browser context. The server
  does not hold user private keys or workspace content keys.

## Limits

- Demo account picker is not a product identity service.
- Production JWT/Cloudflare/Convex gateways are not used.
- Journal recovery replays the durable log; it is not O(1) checkpoint restore.
- 10k/100ms is withdrawn.
