# Keep save-test tasks inside the workspace lifetime

Status: implemented
Translation: pending

## Abstract

The Code Collab durable-save test raced real filesystem work against a 250 ms
deadline. Losing that race left the write running while fixture cleanup removed
its directory, which can produce `ENOTEMPTY` and obscure the original timeout.
The test now blocks publication with an explicit gate, verifies that the save and
disk contents are available before publication completes, and releases its tasks
before cleanup. Product save semantics are unchanged.

## Decision and evidence

The old `Promise.race` did not cancel `saveText`, and its publisher mock never
settled. A larger deadline or recursive-remove retries would retain scheduler
dependence. Use the normal test-runner timeout only as a deadlock guard, not a
performance assertion on disk latency. Release the publication gate in `finally`,
await the save and publisher, and dispose the service before removing the fixture.

The owning service suite passes all 50 tests locally. The original macOS CI
failure has not been reproduced locally; the asynchronous lifetime defect is
visible in the old test, while confirmation on the affected runner remains pending.
