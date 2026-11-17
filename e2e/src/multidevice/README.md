# Desktop multi-device acceptance

Run from the public checkout after building a **private Cloud desktop composition**:

```sh
pnpm --dir e2e exec tsx src/multidevice/runner.ts \
  --adapter /absolute/path/to/private-cloud-fixture.ts --backend legacy
```

This opt-in acceptance lane is separate from `e2e:full` and the OSS journey
registry. Without an adapter it exits 2 and writes `status: blocked`, never a
passing or skipped multi-device result. `--backend native` requires runtime
observations of the loaded engine, client and json-patch SDKs at `0.1.0`.
The migration reference source is `1d80000d7f6b7301442a6e2c7c558cd69e6ab88a`;
unreleased upstream changes are outside that acceptance target. The public test does not install
or depend on the engine; it is reusable for the migration's eventual Cloud build.
Roost sessions are outside this lane.

The driver operates real Playwright Electron pages. For both same-account devices
and different workspace members, A creates a Session through the composer, B
opens it through the sidebar, both observe streaming, and the deterministic ACP
finishes only after both observations. B sends a follow-up to the same Session.
While B is offline, A completes another turn. B restarts using the same data and
network gate, reconnects, reads the complete history, and sends another follow-up.
A then restarts its execution owner too; both histories contain each uniquely
marked prompt and reply once.
A shared daemon/Repo owner, overlapping data directories, wrong membership, lost
state after restart, duplicate ACP dispatch, or cleanup failure fails the round.

## Independent-profile prerequisite

```sh
pnpm e2e:build
pnpm --dir e2e exec tsx src/multidevice/isolation.ts
```

This launches two real OSS Electron applications, verifies different main and
daemon PIDs, host endpoints, local accounts/workspaces and actual Repo SQLite
files, then completes a file-gated ACP conversation on each and reads it back
after a full profile restart. Evidence is retained under
`e2e/artifacts/multidevice-isolation/round-*`. Its successful status is
`isolation-passed` with `cloudSync: unmeasured`; it cannot establish synchronization.

## Private fixture boundary

Default-export the `CloudFixture` interface from [contract.ts](contract.ts).
Its implementation belongs in the private outer repository. It must:

- Create a fresh loopback-only Convex deployment, Worker ingress and real authenticated Streams/Riverrun
  data for each membership round; provision synthetic accounts and a shared ordinary
  workspace through the actual auth/membership authority. Never reuse a user's
  deployment, account, credentials, local service or data directory.
- Launch two built Cloud Electron applications with distinct temporary profiles,
  Lody data, host endpoints, daemons, and Repo/engine owners under the supplied root.
  Register each through the normal product chain. Set the supplied external ACP
  command on each machine and enter the ordinary workspace with the composer ready.
  Both commands are executable on this test machine; separate physical hosts need
  their own fixture paths. The external provider is the only simulated service.
- Return runtime observations of account/workspace/machine identity, daemon and
  Repo owner PIDs, Repo instance identity, host endpoint and actual directories.
  Do not report requested configuration as observed runtime state. Native SDK
  version comes from the loaded host. No raw engine or synthetic state injection
  is permitted as a substitute for product Session operations.
- `setOnline(false)` must close existing and block new cloud connections for that
  actor's renderer, main, daemon and data host. Resolve after the gate acknowledges
  the cut. Preserve loopback UI-to-daemon communication and ACP file barriers.
  Playwright `context.setOffline` alone does not control main/daemon connections.
  Record the gate's blocked connections; restore only that actor on reconnect.
- Restart must await termination of the old client and daemon/data owner, keep the
  same profile/data, preserve the offline gate and return a new application/page.
  The round owns replacement actors too. Cleanup must attempt every actor and
  service, await exits and endpoint release, and report failures. Partial fixture
  creation must clean up before rejecting.
- Retain screenshot, trace, main/renderer logs, CLI backlog, process tree, network
  gate evidence, exact source/build/service versions and service failure logs
  under the supplied artifacts path. Keep synthetic account secrets out of logs.

Artifacts use fresh `e2e/artifacts/multidevice/round-*` directories. Public runner
results describe assertions, not independent certification of a private adapter;
review the adapter and its network/process evidence before accepting a run.

## Infrastructure gaps

`e2e:full` launches the built OSS desktop with its embedded local CLI and scripted
ACP. It does not launch Convex, Worker or Riverrun. Two such profiles have separate
local identities/workspaces and cannot exercise product-cloud collaboration.
`packages/e2ee-lab/test/ledger-fixture.ts` starts real SQLite Riverrun HTTP and the
Lab's multi-actor tests cover native content/ledger boundaries, not desktop login,
workspace membership, Machine RPC or a product conversation. Substituting that Lab
host for the Cloud authority would shorten the client chain being tested.

The private outer repository's `scripts/lody-local-e2e.mjs` is a developer service
launcher. Its service list uses fixed ports, allows external-service reuse, and
starts one CLI; it does not provision per-round synthetic members, a fresh
Convex/Riverrun store or two Cloud desktop replicas. Reusing it unchanged cannot
satisfy this fixture.

The current private `local-stack/` is the appropriate reuse target instead:
`local-stack/scripts/config.mjs` owns named instances/port offsets;
`local-stack/scripts/stack-native.mjs` owns actual upstream gateway/dashboard/rr
and isolated Convex; `local-stack/desktop/login.mjs` provisions synthetic accounts
and performs product browser login; `native-debug.mjs` owns two independent native
profiles and their driver lifetimes. The real rr stack uses its supported durable
storage, rather than the Lab's unauthenticated SQLite development server. Native
Worker relay coverage is limited to its explicitly supported routes and must stay
visible in any result; it is not acceptance of Worker uploads or runtime downloads.

The public runner's private adapter has not been implemented. Reuse the existing
private launch/login/drain owners rather than duplicating them. Its current
controller carries Playwright work in owned child drivers; it does not export
in-process `ElectronApplication`/`Page` handles for this interface. Bridging the
UI/observation contract, ordinary workspace membership setup and a network gate
covering all processes remains private integration work. A fresh private checkout
also needs its own root installation, public source override and named stack startup;
preflight success alone would not execute these scenarios. The implemented public
scenarios and passing OSS isolation check do **not** complete desktop multi-device
synchronization acceptance.
