# @lody/e2ee-lab

[中文](README.zh.md)

Local deterministic E2EE collaboration lab. Not product E2EE and not Lody
integration. Honest clients are programs; only an attacker Agent (P4) explores
malicious-server mutations at recorded event boundaries.

## Commands

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run attack:model   # needs a model key (OPENROUTER_KEY etc.)
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/repro-cli.ts replay /path/to/pack
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` is typecheck plus tests. Root commands do not build the old demo UI.
`scenario:collab` runs the ongoing multi-member script (Alice/Bob/Carol/Dave —
offline reconnect, revocation and epoch rotation, snapshot bootstrap, crash
recovery): a no-attack control first, then fixed attacks at chosen event
boundaries. `attack:model` lets a real model pick the boundary and the attack
while collaboration is in flight. `replay` re-runs CAS, lost-ACK,
ciphertext-mutation and the same recorded attack in three fresh directories
each, model-free, and fails at the first diverging event, entropy request,
protocol frame or client state. Private device material stays in the test
process; it is not written to the public trace. Independent packs
(`e2ee-lab-repro/v1`) bind HEAD **and** the dirty-tree hash; `repro-cli.ts replay`
runs in a new process and prints only the failure fingerprint. Private material
is mode 0700 and is not written to stdout.

## Backend

The host is a thin gateway in `src/platform/host.ts` in front of official sqlite
Riverrun `0.3.0`. Riverrun stores ciphertext and CAS; Org membership and write
rights are decided from the verified ledger, not from Riverrun tables. Malicious
tests still call `riverrunUrl` directly. There is no browser UI. The vendored
continuationOffset streams-crdt tarball is required.

## Status

P2 replay is in `test/replay-bytes.test.ts`. P3 fixed-attack matrix is in
`test/matrix.test.ts`. P4 AttackLab isolation and LLM-free action replay are in
`test/attack-lab.test.ts`. Ongoing multi-member collaboration, boundary attacks
and three-directory model-free replay are in `test/collab-scenario.test.ts`;
real-model intervention is in `test/restricted-agent.test.ts`. AttackLab
clock/fs/HTTP go through Effect `LabClock` / `LabFs` / `LabHttp`
(`src/services/`); Promise methods provide `LiveLabLayer`. Isolation is the
capability handle only: not an OS container, and Effect is not a sandbox.
Reproduction packs, fingerprints, and minimizer coverage live in
`test/repro-pack.test.ts`. Nested streams-crdt import/read request order is not
a controlled microtask boundary; collab replay uses the oldest-runnable FIFO
rule. SIGKILL crash recovery is tested; power-loss of unflushed SQLite pages is
not. See the
[implementation note](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md).
