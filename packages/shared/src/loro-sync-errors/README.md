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
Binding rules: [AGENTS.md](AGENTS.md).

The encrypted-snapshot replay path reports validated `protocol_error` with
`source: payload_protection`, `stage: bootstrap` and `originalCode: gone` when
history is trimmed. Formatting that combination gives a fixed recovery message:
another online complete writer is being asked to upload a fresh snapshot, and sync
will retry automatically. The formatter only explains this; the protected SDK
channel and credential-authenticated host action own the request and retry.
No raw exception message becomes display or diagnostic data.

The projected failure type uses public `RepoStreamsErrorContext` so declaration
emission does not expose the SDK's private context type.
