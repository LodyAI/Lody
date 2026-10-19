# Restore Codex history import routing

Status: implemented
Translation: current

Adapter PR: https://github.com/LodyAI/acp-extension-codex/pull/73

[中文](2026-10-19-codex-history-router.zh.md)

## Abstract

The Codex adapter advertised read-only history support while its production router
omitted the method, causing Lody imports to fail before reading history. Both ACP
protocol chains now register the existing Core history and rate-limit query
handlers. Regression tests use the production router instead of the legacy app
assembly and verify responses, replay and failure behavior. Adapter checks pass;
full desktop import remains unverified in this checkout.

## Cause and repair

At adapter `1404ebae347868b5a49dc0ddefdba833c7a3c63e`, `src/index.ts` connects
`createAcpAgentRouter`, but its v1/v2 chains omitted `_lody/session/history/read`
and `_lody/rate_limits/get`. Capability declarations and the registrations in the
unused production assembly `createCodexAcpApp` survived the entry-point change
(first-parent merge `51a07ee`). The former history transport test only exercised
that old assembly, so it passed despite the production defect.

Register the existing handlers with parameter validation in both production chains.
The host importer and native history reader remain unchanged: no `loadSession`
fallback, session resume or source-history write. See the related
[read-only importer decision](../feature/2026-10-09-dsh-core-capabilities.md).
The root submodule pin carries the adapter fix into bundled builds. Removal of the
legacy assembly and its remaining goal-control test is outside this focused repair.

## Evidence and limits

- Production-router transport tests cover ACP v1/v2, replay before response,
  rate-limit queries, malformed parameters and propagated read failures.
- Removing the two registrations makes all four new transport cases fail;
  restoring them passes. Related history, initialization and v2 replay suites:
  17 tests passed. Existing native-reader cases verify no live session acquisition.
- Adapter `npm run typecheck` and `npm run build` passed.
- Adapter full `npm test` was stopped after remote 401 errors and an unrelated
  session-index canonical-path test failure; it did not pass.
- Root `pnpm check` and `pnpm format` were attempted but blocked by missing root
  dependencies (`tsgo` / `oxfmt`). Nested checkout installation was not attempted.
  `pnpm run docs check` reports links into other uninitialized adapter submodules;
  this note has no reported errors. `git diff --check` passed.
- No real user history was imported or modified. A desktop rebuild and actual
  import still need end-to-end confirmation; unit evidence is not a release claim.
