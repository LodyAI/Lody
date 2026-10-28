# Public E2EE Lab migration

Consume public `@lody/e2ee-core` exports and released SDKs; never copy a second
core, inject signature acceptance, or derive trust from transport offsets.
Effect resolves the root locked 4.0.2; read the repository Effect skill and the
consuming resolved Effect AGENTS before changes. Preserve scope ownership,
abort and await borrowed work before destroying its owner.

Use synthetic local accounts and keys only. The real local Riverrun is a test
transport, not a hosted product, JWT authority or OS security boundary.
Checkpoint selection is independent of hostile transport. A failed read or
SQLite write retains both verified history and its read cursor. Every client
has its own durable file; replay never silently skips already committed hashes.

Content native state and exact SDK cursor commit atomically per document.
Unrecoverable content/format failures and local corruption stop only that document;
native snapshot rejection may replay/retry as described in README.
Network, timeout, 5xx, 409 and permission errors retain active state for retry; failed
recovery preserves both its prior stopped/active status and the durable pair.
SDK subscription precedes local edits; abort is not proof of stopped native work.
Wait actual raw operations before closing SDK/storage or freeing Loro.
Concurrent child-close callers share one completion including cleanup failures;
a second Scope.close call alone is not a cleanup wait. Flock has
no public deterministic free/dispose: close subscriptions and drop references.
Never reset host earliest offsets or delete snapshots to make recovery tests pass.

Current consumers and remaining product/platform boundaries stay explicit in README.
Source-disposition records are historical evidence, not a live completeness checklist.
Do not infer unmeasured security or production acceptance from a consumer's green tests.

Exact fingerprint replay compares all known fields and reports missing observations
as coverage gaps. Shrink preserves measured violations and known trigger facts;
other unmeasured dimensions stay explicit. Generic actions must be independently
owned and immutable; an array copy does not own nested bytes. Synthetic device
exports/native handles are not a recovery vault or platform custody guarantee.

Reference expectations use independently owned observations, never production
policy as expected values. Conjoined action expectations retain each measurement;
aggregate their worst verdict without letting a later pass overwrite a failure. Missing facts stay unmeasured; boolean projections do
not prove agreement. Snapshot eligibility alone never admits a snapshot.

Credential clients capture signer bindings before await, bound credential body
reads, validate returned identity and refuse bearer forwarding to another origin
or after close. SDK transport callbacks keep explicit caller ownership.

Genesis metadata clients verify canonical original signatures and requested hash.
A discovery record is not a current ledger view, checkpoint or authority.

Existing-workspace sessions require independent local/network checkpoint pins and
already published full-prefix control. Failed acquisition closes its child owner;
all close callers await one completion. Stop native admission before joining CAS.

Snapshot cache rows contain bytes, never independent qualification. Every read
reverifies v1 with caller-pinned peer/role/position; no SQL-selected endorser or latest.

Synthetic protection is a Lab-only known-key boundary, never native custody or
production wrapping. Restricted A local restore reads installed protected originals;
it must not silently reopen a historical envelope or relax new sender eligibility.

Finite action plans own a fixed initial JSON-data slice (max256), reject accessors
and unsupported actions before effects, and run native Effect phases. OS crashes
mean actual SIGKILL and awaited exit/close. Private IPC observations must match
independently witnessed signed records; no SQL-selected authority on restart.
Trace only protected protocol paths, excluding credentials; bound frames/bytes and
report missing observations. Measured action success is not whole-security or exact
ciphertext replay. Flock has an explicit monotonic clock and shared document owner.

Negative action expectations require exact refusal tag/code; untyped, defect and unrelated failures are harness errors, never successful negative evidence. Artifact inspection recomputes observations but does not authenticate them. HTTP/SDK callbacks use the fixed-scope LabCallbackRunner bridge; native workflows never use it as a second orchestration path.
SDK failure normalization must not erase provider defects; action consumers check the provider harness signal after actual SDK settlement.

Use current-format APIs and explicit allow/deny/unmeasured reference predictions. No obsolete boolean aliases or source-era unauthorized-content classifications. Native SDK callback bridges are lifecycle adapters, not legacy-ledger readers.

Native phase scheduling uses the Effect PhaseParent context only. Register each waiter before notifying synchronous consumers; retain the first typed failure before closing other gates. No unused pause/intercept/freeze/start-log or Promise-phase compatibility API.

Key rounds are finite pages, with separate caller-supplied hints for each queue.
Session/IPC results are returned intact; repair IDs and targeted rejection are
caller choices. Acknowledge each consumed result explicitly, never automatically
or by deleting original task/report/ciphertext rows.

Current host composition refreshes actual signed control before authorization. A
verified observation that fails persistence remains an in-process lower bound:
block authority/checkpoint export and old-prefix rollback until confirmation.
Reopen still needs an independently retained minimum; SQL cannot supply it.
Offline edits persist native state with the old cursor without networking or
sealing; the existing SDK synchronizes deltas under current epoch/permission.
Attack plans receive bounded public response controls, never credentials or
honest-device secrets. A retained old prefix is pending sync, not automatically
a detected fork; compare only externally qualified exact observations.

Staged epoch plans reuse original pre-dispatch groups and candidate inputs, never
recorded terminal results, installed keys, documents or cursors. Replay reexecutes
real native imports, HTTP, validation and persistence. Backend confidentiality
observations read bounded actual entries/snapshots without changing retention or
using SQLite to select authority. Missing property observations stay unavailable.

Opaque staging storage does not verify an occupied claim against the ledger.
The HTTP boundary authenticates the original record signer for stage/delete,
verifies record/envelope signatures and retains immutable whole groups. Other
management devices cannot delete a publisher's group. Honest clients separately
qualify same-epoch loss; malicious publishers may still withhold their own key.

Owned SQLite files use the shared current-format helper for exclusive creation, application/version checks, WAL/FULL and opening bindings. Read-only foreign/attack observers use its connection constructor without claiming an application format. Local hostile-process database mutation audits are outside the threat model; verify signed history on open and retain transactions plus target-row readback.

`pure/canary.ts` checks caller-observed synthetic Streams/HTTP bytes; missing
exit coverage must fail. `canary-cli.ts` reads bounded synthetic manifests, never
client plaintext caches. `test/canary.test.ts` captures real protected Loro/Flock
HTTP and Riverrun storage, with deliberate leak controls. The isolated Electron
IPC/IndexedDB trial in `apps/electron/scripts/e2ee-ipc-benchmark.md` imports exact
released SDK entrypoints through `platform/ipc-benchmark-dependencies.ts`; its
measurements are separate from product acceptance and never export main keys.
