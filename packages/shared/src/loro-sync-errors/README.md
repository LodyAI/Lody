# Loro sync errors

`index.ts` owns the safe scalar projection, bounded report/cause traversal and
technical error formatting shared by CLI and renderer. Bind
`createLoroSyncErrorTools({ RepoTransportError, RepoSyncError })` using the caller's
imports from `loro-repo`: pnpm peer contexts can resolve distinct runtime classes.

The resulting tools collect transport failures, format their evidence, and build
warn/error diagnostic records. Non-Streams errors return no formatted detail;
normal diagnostic activity returns no record. Callers own their existing logger
or console sink and localized action label. No tool mutates failures or enables
telemetry.

Binding rules: [AGENTS.md](AGENTS.md). Intent:
[sync diagnostics](../../../../specs/streams-sync-diagnostics.md).
