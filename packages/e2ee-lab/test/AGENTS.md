# E2EE Lab tests

Parent package and repository rules apply.

Retain tests that exercise public E2EE core behavior through real crypto,
persistence, SDK transport or process recovery and assert the resulting state.
Lab plan parsing, scheduling, reference predictions, verdict aggregation, replay,
shrinking and observer bookkeeping are test-tool implementation details. Their
self-tests are removed even when they use a real HTTP server or SQLite fixture.
Mixed suites keep only the concrete product/domain cases. The Lab helpers remain
available to the retained integration tests.
