# @lody/e2ee-lab

[中文](README.zh.md)

Local deterministic E2EE collaboration lab. Not product E2EE and not Lody
integration. Honest clients are programs; only an attacker Agent (P4) explores
malicious-server mutations at recorded event boundaries.

## Commands

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab run replay
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` is typecheck plus tests. Root commands do not build the old demo UI.
`replay` re-runs CAS, lost-ACK and ciphertext-mutation scenarios in three fresh
directories each and fails at the first diverging event, entropy request or
protocol frame. Private device material stays in the test process; it is not
written to the public trace.

## Backend

The first lab host reuses the official sqlite Riverrun adapter from
`@lody/e2ee-demo/host`. P5 moves that adapter here and deletes the demo/game UI
after the scenario matrix covers it.

## Status

P2 replay and P3 fixed-attack matrix are in `test/replay-bytes.test.ts` and
`test/matrix.test.ts`. The Agent API is P4. See the
[implementation note](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md).
