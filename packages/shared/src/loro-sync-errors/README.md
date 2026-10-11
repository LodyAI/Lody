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
