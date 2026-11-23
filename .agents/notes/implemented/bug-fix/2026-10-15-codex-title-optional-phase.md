# Preserve Codex title answers without message phases

Status: implemented
Translation: current

[中文](2026-10-15-codex-title-optional-phase.zh.md)

## Abstract

A configured Codex title model could return a valid title that Lody discarded because
it lacked `final_answer` metadata. Codex's protocol explicitly permits an unknown
phase, so phase absence cannot identify a failed response. The title collector now
accepts unphased assistant text and prefers an explicit final answer when available.
Commentary, pre-prompt output, error payloads, and failed prompts remain excluded.
This fixes the response compatibility defect without changing saved model selection
or Provider authentication; it does not establish availability of any live endpoint.

## Decision and evidence

This complements [client-owned Codex titles](../architecture/2026-10-10-codex-client-titles.md).
The adapter's generated `MessagePhase` contract calls for compatibility when the
phase is unknown. Its event handler preserves that absence. Lody previously required
`final_answer` for every Codex chunk; the successful ACP prompt response contains
completion metadata rather than the answer, so discarded text could not be recovered.

Keep explicit final and unphased text in separate buffers. Prefer the explicit final
stream rather than concatenating it with unclassified interim text. Clear both after
startup/configuration and before the title prompt, then sanitize the chosen stream
as a whole so fragmented error envelopes are rejected. Explicit commentary remains
ineligible. Authentication, title configuration validation, prompt failure recovery,
and process cleanup retain their existing owners and behavior.

The fix stays in ordinary output processing. Migrating the auxiliary ACP lifecycle
would pull in unfinished process/startup dependencies and is deferred under the
Effect selection guide; no native migration completion is claimed.

## Validation

The owning suites cover a saved custom title model and synthetic provider environment,
unphased and fragmented answers, explicit commentary, final-answer precedence,
startup/configuration banners, fragmented errors, and failure after partial output.
In a standalone clone with frozen dependencies, all 33 tests across the two title
suites and the message-handler title suite passed, as did CLI typechecking, scoped
Oxfmt and Oxlint. Replacing only the implementation with HEAD reproduced the defect:
the custom-model regression returned `Original task` instead of `Custom endpoint title`.
Docs validation reports six existing links into uninitialized Kimi/Pi submodules;
none concern this change. Full `pnpm format` passed. Full `pnpm check` passed repository typechecks and lint,
then stopped at the unchanged recursive SSH submodule test in
`github-git-transport.test.ts`: the host credential bridge reported `context_unreadable`.
CLI reported 4270 passing tests, one failure, and four skipped tests; later chained
checks were not reached. No live endpoint request was made.
