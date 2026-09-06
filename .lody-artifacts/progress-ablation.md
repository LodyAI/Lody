# Creation-progress ablation results

Baseline: `cf5568ad` (PR #439). Each variant was applied independently to the
baseline sources, tested, and restored before the next experiment. Only passing
simplifications were combined. No failing variant is retained.

The fixed baseline contains 104 tests across `operation-progress-history`,
`operation-coordinator`, `session-dispatch-logic`, and `lody-mcp-server`. Two added
regressions cover all 25 status/label merge transitions and identical-history
object preservation. Tests use synthetic fixtures and explicit failure injection.

| Variant                                                                                             | Result                                                                              | Decision                                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A: remove unused boolean return and `changed` bookkeeping from the progress upsert                  | 104 passed                                                                          | Keep removal; no caller consumes the return value      |
| B: collapse merge branches and replace duplicate terminal-set classification with the existing rank | 104 passed, including 25 transitions                                                | Keep simplification                                    |
| C: hoist the identical progress write from both `changed` branches                                  | 104 passed                                                                          | Keep simplification; write ordering/count is unchanged |
| D: remove the second terminal progress write                                                        | 103 passed, 1 failed: pending-delivery repair after two injected write failures     | Restore retry                                          |
| E: remove the identical-snapshot no-op guard                                                        | 103 passed, 1 failed: original history object was replaced                          | Restore guard                                          |
| F: replace success-state freshness checking with target-presence checking                           | 102 passed, 2 failed: complete rows still marked created/running hid fallback cards | Restore freshness check                                |
| G: remove the single-use type guard and unnecessary `MessageContent` assertion/import               | 104 passed; CLI typecheck passed                                                    | Keep type-inferred form                                |

Reproduce the fixed regression suite:

```sh
pnpm --filter lody exec vitest run tests/operation-progress-history.test.ts src/orchestration/operation-coordinator.test.ts tests/session-dispatch-logic.test.ts tests/lody-mcp-server.test.ts
```

Combined A+B+C+G: **104 passed**. Also passed `pnpm check`,
`pnpm format:check`, `pnpm run docs check --base origin/main`, and
`git diff --check`. These are regression/equivalence checks, not a throughput
benchmark or proof of every possible cross-machine interleaving.

Production TypeScript is 22 lines smaller. The obsolete PR-creation shell script
and duplicated PR-body file (107 lines) were also removed; neither has repository
consumers or runtime behavior. The existing four screenshots are preserved.

## Follow-up after durable-progress review fixes

Baseline: `13b0f8c0`. This round re-evaluates the latest PR implementation,
including independent post-Delivery progress ownership and real-replica duplicate
repair. Each of nine variants was tested independently, restoring both production
files between experiments. The fixed suite has **149 tests**: the previous 148
plus a regression ensuring that an omitted label does not erase a published one.
No failing production variant is retained; screenshots are unchanged.

| Variant                                                                                      | Isolated result      | Final decision                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| A: compute each incoming target key once during merge                                        | 149 passed           | Keep; removes duplicate string construction                                       |
| B: let TypeScript infer the progress filter predicate                                        | 149 passed           | Keep; verify with CLI typecheck                                                   |
| C: use equal Map sizes plus existing per-key/status checks instead of a second key traversal | 149 passed           | Keep; equal sizes and membership of every expected key establish the same key set |
| D: remove progress repair from the Delivery path                                             | 149 passed           | Keep; the independent pending-progress pass/retry owns this work now              |
| E: remove the immediate terminal-progress retry                                              | 149 passed           | Restore after the combined experiment below                                       |
| F: remove native Loro duplicate aliasing                                                     | 148 passed, 1 failed | Restore; interrupted duplicate repair no longer yields distinct physical row IDs  |
| G: remove the local Loro flush before SQLite settlement                                      | 148 passed, 1 failed | Restore; failed durability is incorrectly acknowledged as settled                 |
| H: remove the existing-item spread during merge                                              | 148 passed, 1 failed | Restore; a later snapshot without a label loses the published label               |
| I: remove the root-error branch's extra progress write and unused result binding             | 149 passed           | Keep; root-error finalization returns to the independent pending-progress pass    |

Combining all isolated passing variants (**A+B+C+D+E+I**) failed one test:
`repairs terminal create progress during pending completion delivery`. Removing
both D and E exhausted the immediate repair opportunities after two injected
write failures. Restoring E while keeping D produced **149/149 passing**. This
interaction is why isolated green tests alone are insufficient.

Final combination: **A+B+C+D+I**. The terminal retry, duplicate repair, flush,
no-op/freshness safeguards, and label preservation remain. C uses an early size
mismatch return for readability; per-key/status checks are unchanged. Production
TypeScript is seven lines smaller, and the cleanup removes two redundant progress
write sites rather than weakening durable recovery.

Reproduce this round's fixed suite:

```sh
pnpm --filter lody exec vitest run tests/operation-progress-history.test.ts src/orchestration/operation-coordinator.test.ts src/orchestration/operation-store.test.ts src/orchestration/operation-model.test.ts tests/session-dispatch-logic.test.ts tests/lody-mcp-server.test.ts
```

These experiments establish tested behavioral equivalence, not a throughput
benchmark or exhaustive proof of every cross-machine interleaving.

Final validation passed: `pnpm check` (including CLI typecheck and the full test
suite), `pnpm format:check`, `pnpm run docs check`, the 149-test focused suite,
and `git diff --check`.
