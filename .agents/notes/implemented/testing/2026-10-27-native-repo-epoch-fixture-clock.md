# Keep native repo epoch fixtures on real timers

Status: implemented
Translation: current

[中文](2026-10-27-native-repo-epoch-fixture-clock.zh.md)

## Abstract

The image epoch tests could finish their assertions and then hang while closing the repository. Their fake timeout clock could capture a legitimate persistence yield; switching back to real timers at teardown discarded its callback without settling the repository operation. These four tests now keep real timers for the entire repository lifetime because they test epoch ownership, not elapsed time. Existing explicit upload gates, assertions and the 30-second timeout remain unchanged.

## Decision and evidence

`loro-repo` 0.25 yields through `setTimeout(0)` when persistence exceeds its 5ms work budget and more dirty work remains. The fixture kept real `performance.now()` while faking timeout timers. A pending yield therefore depended on advancing the fake clock; uninstalling that clock could strand the owned persistence promise awaited by `repo.destroy()`.

An injected monotonic clock advancing 10ms per read deterministically exercised this allowed slow branch. A timer stack identified `DocManager.drainDirtyDocs`; upload completion, assertions, presence release and execution drain had completed before repository destruction stalled. The original CI record contained only a timeout, so it does not prove the duration of a particular export on that runner.

The owning 71-test file passed with this fixture-only change. All four epoch variants also passed in five independent processes under the same injected yield condition, retaining the original timeout. Reverting the change reproduced the cleanup stall. No production code, payload, assertion, dependency or timer threshold changes. Fake-clock batch-window tests remain unchanged. Downstream pinned compositions need to adopt the corrected source; a successful rerun of the old source does not remove the defect.
