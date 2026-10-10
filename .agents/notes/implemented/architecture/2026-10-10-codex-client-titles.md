# Move Codex titles to the configurable Lody session

Status: implemented
Translation: current

[中文](2026-10-10-codex-client-titles.zh.md)

## Abstract

Codex's adapter generated titles with a hardcoded model, bypassing the Provider's
title settings. Lody now owns builtin Codex title generation through its existing
isolated session and exposes those settings, defaulting to gpt-5.6-luna, low
reasoning, and full access. Removing the adapter generator avoids duplicate requests,
including recursive naming of the title session. Explicit native names remain supported;
other Providers keep their existing title ownership.

This partially supersedes the Codex ownership decision in
[ACP-owned titles](2026-09-08-acp-owned-session-titles.md) and the Codex portion of
[title capability negotiation](../feature/2026-09-24-acp-session-title-capability.md).
The [Spec](../../../../specs/acp-session-titles.md) remains draft.

## Responsibilities and limits

The shared predicate excludes builtin Codex even for stale capability caches. Both
session dispatch and Provider settings use it. Existing non-empty title settings
win over defaults; runtime option validation rejects unavailable Codex choices rather
than quietly using another model. Failures retain the existing prompt-derived fallback.
The isolated session preserves the Provider's authentication and never changes the main
conversation's model or permissions. Full access is limited to the isolated title
session's configuration; its existing temporary working directory and client-side
permission handling are unchanged.

The adapter retains explicit native names and fallback previews but removes its title
model turn, capability advertisement, and obsolete generation lifecycle. Deployment
must include the updated adapter; older adapter binaries can still generate their own
titles. Submodule changes and host changes form one coordinated delivery.

## Validation

Behavioral coverage checks settings visibility/saving with stale ownership caches,
explicit overrides and defaults at the isolated prompt boundary, unavailable options,
Codex versus other-provider dispatch, native title events, and adapter lifecycle.
No real model request is needed to verify configuration and ownership; live account
availability of the default model is not established by these tests.

Validation completed: 372 scoped tests passed, along with shared/CLI/components/Codex
typechecks, adapter builds, scoped lint (warnings only), and the public-boundary check.

Full pre-PR `pnpm check` passed typechecks and lint but stopped at the unchanged
`github-git-transport.test.ts` recursive SSH clone case: the local Git credential
bridge reports `context_unreadable`. A focused rerun reproduced it (5 other cases
passed); CLI reported 3707 passing tests. `pnpm format` passed.

Companion adapter PR: [acp-extension-codex #68](https://github.com/LodyAI/acp-extension-codex/pull/68).
