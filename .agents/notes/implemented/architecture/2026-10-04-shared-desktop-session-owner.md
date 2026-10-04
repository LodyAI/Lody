# Shared desktop Session ownership

Status: implemented
Translation: current

[中文](2026-10-04-shared-desktop-session-owner.zh.md)

## Abstract

Opening a second local desktop window used to import another Session document and
construct another history projection before it could display the conversation.
One main-owned data renderer now retains Session documents and the UI writer;
product windows consume indexed, windowed projections through IPC. This removes
repeated document import while retaining writer validation and acknowledging writes
only after document persistence. On a synthetic 3,000-entry conversation, the final
ten-sample repeat reduced immediate-click show/input medians by about 24%. A dedicated
renderer adds memory and first-open work; these costs remain explicit in the evaluation.

## Decision and boundaries

The data renderer is independent of the optional warm-window pool. It starts with
local workspace composition and retains its own Repo/storage/cursor namespace.
Each product window still owns metadata, drafts, attachment preparation, editors
and its ConversationView. The CLI remains the agent author; UI commands never become
CLI write-intent commands. Cloud/web composition remains direct.

The owner reuses SessionData/HistoryWriter for history and WorkspaceWriter for queue
changes. The first response includes a cached shallow directory and at most 30 tail
turns; subsequent body reads are batched. Each viewer still constructs an O(total)
directory. Full export/fork reads remain explicit. The connection retains actual
writer-captured snapshot handles behind opaque IPC references; this lookup grants
no independent copy provenance. Collection or connection close releases them.
Rollback handles also hold their source store until release.

Main authenticates product frames and the exact data renderer. Leases, sequence
numbers and owner incarnations fence stale observations and replies. Closing one
view releases only its subscriptions; quit drains accepted operations before stopping
relays. A dead owner rejects pending commands as potentially committed, without
replay. View subscriptions reopen, invalidate their projections and read persisted
state. Failed reopening remains an error rather than creating a second writer.

Existing per-window Session snapshots seed cold owner storage before subscription,
merge into already owned documents, persist, and remain in their original cache; storage/cursor checkpoints are never shared by independent Repos.
History/queue acknowledgements wait for per-document persistence, not a Repo-wide
flush. Queue watermarks also persist before acknowledgement. Pending attachments
and editor drafts remain window-owned, so their unload protection remains necessary.
Their guards now log only the blocking kind/count/status, without message or file
contents. The reported original close veto remains unestablished.

A full utility-process migration was not selected: the current runtime uses browser
IndexedDB and Electron's renderer transport. Reusing it keeps one synchronization
and writer implementation, at the cost of another Chromium renderer. Moving only
the owner into a DOM-free worker requires extracting those runtime dependencies;
this change does not claim that memory optimization.

## Evaluation

The [desktop runner](../../../../packages/components/benchmarks/window-bootstrap/README.md)
uses generated conversations, isolated profiles and the same built CLI/application
for both variants. `LODY_SHARED_SESSION_OWNER=0` selects the former independent
Session replicas **for isolated comparison**, not a cache migration/rollback path.
The harness now uses the current warmup IPC, releases its import-only fixture handle,
records process working sets and rejects unexpected native close confirmations.

The [recorded evaluation](../../../../packages/components/benchmarks/window-bootstrap/README.md#shared-session-owner--2026-10-04)
contains samples, build hashes, reproduction commands and failed attempts. On M4 Max /
Electron 43.7.6, the final reversed-order ten-sample repeat reduced immediate-click
show from 499.04 to 379.80 ms and input confirmation from 621.70 to 468.52 ms. The
earlier five-sample pair improved by 16.9% / 15.0%, so 24% is not a universal target.
Ready hits measured 83.14 ms show / 162.29 ms input with sharing (three samples).
All 70 completed content/input/clean-close checks passed, including warmups. Forced
owner death recovered an acknowledged write and the source view in 1,128.88 ms.

At input confirmation, one-at-a-time opening increased the median summed process
working set by 472 MiB; at the fifth retained auxiliary window it was 7.3% lower.
These are opening-time samples, not steady residency. The fresh fixture import /
first-source-conversation interval increased from 1.19 to 1.98 seconds; this includes
legacy cache migration and is not whole-app startup. The extra renderer is a real
cost, while document sharing becomes more useful across simultaneous views.
Two exploratory prepared-hit probes timed out before intent IPC; the final runner
focuses the source and settles metadata updates before hover. Both variants then
passed, but the exact cancellation trigger was not isolated.

The [idle-memory evaluation](../../../../packages/components/benchmarks/window-bootstrap/README.md#idle-memory-and-retention)
adds 45-second source/prepared observations and a 30-second post-close observation,
without forced GC. Using macOS physical-footprint accounting for Electron processes
(excluding external CLI/daemon processes), source-only memory was 616.15 MiB with
independent ownership and 742.37 MiB with sharing. One prepared hidden view brought
the shared total to 969.42 MiB: about 227–236 MiB extra versus the before/after source
samples. The data renderer used about 131–147 MiB; the settled prepared renderer used
203.71 MiB. These counters differ from the earlier summed working sets.

After closing five auxiliaries, the shared total returned to 753.93 MiB, with no
auxiliary renderer processes remaining. Both variants completed eight stages, with
66 OS samples total and no close confirmation. One preliminary run exposed natural
reclamation after ten seconds and a process-exit sampling race; it is excluded from
the final comparison. A 250–300 MiB extra budget for one hot view is a reasonable
initial proposal for this fixture. Multiple hidden views remain unimplemented.
All windows here share one Session and the source remains open; distinct documents,
their ten-minute store-cache grace period, and hours-long retention are unmeasured.

## Verification and limits

Behavioral tests use real Loro readers/writers across a structured-clone transport:
shared ownership, independent closure, an edit during initial observation, legacy
merge, cross-session snapshot provenance, storage failure, concurrent queue identities,
owner replacement, uncertain tail-edit outcomes, later observers and connection/workspace fencing. Reader background failures no
longer escape as unhandled rejections. Real desktop probes validate content and unique
text insertion at first show; process-recovery evaluation checks an acknowledged write.

The final targeted suites passed 64 tests, including 11 owner/client cases; Electron
passed 199 tests. Type checks, production build, lint, i18n and platform/public/import
boundaries passed. The broader `pnpm check` reached 4,773 passing components tests
with one failure in unchanged `boot-shell.test.tsx` (storage-unavailable fallback);
that case also fails alone in the Node 26 environment. CLI's 3,454 and shared's 1,271
tests passed. Documentation validation has six existing broken links into absent
isolated Kimi/Pi submodules in the evaluation clone (62 absent-submodule links in
the dependency-free checkout), with no new-document link failures.

Validation ran in a separate clone because the nested checkout has no dependencies.
Existing submodule/lockfile drift required a non-frozen install there; its lockfile
was not copied back. Both performance variants used the same dependency tree and
built CLI. The installed product and its profiles were not changed.

Timing excludes physical input, display scanout and IME. Prepared hits are an ideal
case, not a claim about prediction hit rate. Opening-time working sets, idle macOS
footprints and diagnostic JS heap counters are recorded separately. None establishes
a population memory budget. Small sequential runs do
not establish a population P95. Old auxiliary caches can only be merged when that
cache namespace is opened; they are not deleted or scanned globally.

Intent: [desktop windows](../../../../specs/desktop-windows.md). Prior investigation:
[close diagnostics](../../proposed/architecture/2026-10-04-desktop-window-lifecycle-diagnostics.md).
