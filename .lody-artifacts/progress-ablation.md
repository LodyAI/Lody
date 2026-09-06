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
