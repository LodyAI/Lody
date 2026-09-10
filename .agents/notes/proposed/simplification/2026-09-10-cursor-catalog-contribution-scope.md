# Narrow the Cursor catalog contribution through ablation

Status: proposed
Translation: pending

## Abstract

The Cursor catalog contribution also introduced general Role availability and restoration
behavior, with a separate capability-source publication protocol. Removing that group leaves
the selected-model picker and CLI/MCP tests passing, while its own behavioral tests fail as
expected. The proposed contribution therefore keeps the Cursor path and separates the Role
work for independent review. This is a scope reduction, not evidence that Role freshness and
restoration safeguards are unnecessary.

## Scope and evidence

This follows [Issue #343's maintainer feedback](https://github.com/LodyAI/Lody/issues/343#issuecomment-5611912115).
The experiments use PR #345 at `1754cd3a`, including PR #344 at `4349818d`, against
their recorded base `be639221`. Each mutation starts from the same baseline, and tests
remain unchanged until the behavioral comparison is recorded.

| Removed behavior                                   | Baseline   | After removal        | Decision |
| -------------------------------------------------- | ---------- | -------------------- | -------- |
| Target-model option composition                    | 33 passed  | 25 passed, 8 failed  | Keep     |
| Model switch before per-model options              | 9 passed   | 8 passed, 1 failed   | Keep     |
| Catalog inheritance when a write omits it          | 13 passed  | 11 passed, 2 failed  | Keep     |
| Picker source-marker compatibility check           | 10 passed  | 8 passed, 2 failed   | Keep     |
| General Role availability/source/restoration group | 439 passed | 437 passed, 2 failed | Separate |

The last two failures are the Role row's unsupported-model/mode explanations. Separate
Role availability controls change from 25 to 17 passing shared tests and from 13 to 2
passing hook tests; these are observable losses of the separated feature. Tests of removed
APIs are not counted as behavioral failures. The final scoped suite retains 437 tests.

## Responsibilities and trade-offs

Keep registry-only picker opt-in, live/explicit catalog discovery, tri-state catalog writes,
mixed-daemon picker negotiation, refresh publication, and target-model CLI/MCP dispatch.
Keep Role parameter editing and model-change pruning, including Task/reviewer consumers;
removing them would leave parameters that the newly selected model cannot accept.

Separate general Role model/mode availability checks, exact capability-source/epoch
publication, runtime-install listeners, and deferred landing restoration. These paths follow upstream behavior; the integration preserves subsequent upstream
Role mention discovery and availability changes. Existing machine/config binding, authorization, frozen MCP
Role dispatch, and permission handling remain. Preemptive rejection of a retired Role model
and capability-aware saved-Role restoration are not guarantees of this narrowed contribution.

The experiments are deterministic source tests, not live Cursor, desktop, or Windows
acceptance. Both PRs remain Draft pending maintainer review. The independent
Role patch retains its original implementation and tests for later review.

## Integration

The reduced catalog branch integrates upstream `1ce45684`; its Plan-mode tests and
Cursor target-model tests are both retained. PR #345 builds on that reduced branch,
preserving the existing contribution ancestry. General Role files match upstream;
the separate patch is not part of either final PR diff.
