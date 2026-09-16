# @lody/e2ee-lab

[中文](README.zh.md)

Local deterministic E2EE collaboration lab. Not product E2EE and not Lody
integration. Honest clients are programs; only an attacker Agent (P4) explores
malicious-server mutations at recorded event boundaries.

## Commands

```sh
pnpm --filter @lody/e2ee-lab check
pnpm --filter @lody/e2ee-lab run scenario:collab
pnpm --filter @lody/e2ee-lab exec tsx src/cli.ts --data-dir /tmp/e2ee-lab-data
```

`check` is typecheck plus tests. Root commands do not build the old demo UI.
Replay commands land in P2.

## Backend

The first lab host reuses the official sqlite Riverrun adapter from
`@lody/e2ee-demo/host`. P5 moves that adapter here and deletes the demo/game UI
after the scenario matrix covers it.

## Status

P1 persistent three-client collaboration is the current gate. Attack recording,
replay, and the Agent API are later stages. See the
[implementation note](../../.agents/notes/proposed/testing/2026-09-16-e2ee-adversarial-lab.md).
