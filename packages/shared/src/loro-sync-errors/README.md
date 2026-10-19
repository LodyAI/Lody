# Loro sync errors

`index.ts` owns the safe scalar projection, bounded report/cause traversal and
technical error formatting shared by CLI and renderer. Bind
`createLoroSyncErrorTools({ RepoTransportError, RepoSyncError })` using the caller's
imports from `loro-repo`: pnpm peer contexts can resolve distinct runtime classes.

The resulting tools format transport failure evidence and build
warn/error diagnostic records. Non-Streams errors return no formatted detail;
normal diagnostic activity returns no record. Callers own their existing logger
or console sink and localized action label. No tool mutates failures or enables
telemetry.

Display and diagnostics use the same scalar projection; error detail serializes
that projection as JSON rather than maintaining another list of display fields.
The projected return type uses public `RepoTransportError` property types so
declaration generation also works when Repo derives its context from SDK types.
Binding rules: [AGENTS.md](AGENTS.md).

Native workspace consumers additionally bind `nativeFailures` to
`workspaceSyncFailuresLegacy`. That constructor-bound bridge traverses retained
native Causes and selects the Repo transport's validated public projection.
Private Causes and payloads remain available for recovery and are never formatted.
The error context keeps `abortKind`, `timeoutKind` and `uploadStage` when the SDK
provided them, together with stage, request correlation and actual elapsed time.

CLI and renderer register `snapshotUpload.onDiagnostic` and use
`getLoroSnapshotDiagnostic` for an explicit scalar projection. Snapshot workflow
and request ids correlate permission/auth/HEAD/export/encode/PUT stages. Records
include outcomes, encoded request body length, stage and workflow elapsed time,
status, upload mode and any real transmission progress. Budgets remain separate
from elapsed time; ordinary fetch is `total-only` and supplies no inferred upload
substage. Normal snapshot observations use debug and failures use warn, with no
URL, headers, payload, token, arbitrary message or full Cause. Renderer preserves
the configured protected-content observer and its asynchronous failure isolation.
