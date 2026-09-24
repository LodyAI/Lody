# Require conversation-sharing disclosure

Status: implemented
Translation: current

[简体中文](2026-09-21-required-conversation-handoff.zh.md)

## Abstract

External PRs could omit authoring conversations without explaining whether sharing
was requested or declined. The accepted change requires a sharing status and either
a public link or a concrete explanation. A user's refusal additionally requires a
separate verbatim reply alongside the original prompt. Publication stays voluntary,
and automated checks cannot prove that the disclosure is truthful.

## Decision and evidence

[PR #829](https://github.com/LodyAI/Lody/pull/829) omitted the sharing section while
passing the previous body validator. This partially replaces the
[optional-sharing decision](2026-09-17-shared-conversation-pr-handoff.md): the original
prompt and user-controlled publication remain, but silently deleting the sharing
section no longer satisfies external intake. Merely strengthening an Agent reminder
would leave the same unobservable gap.

The [draft contract](../../../../specs/pr-conversation-handoff.md) defines the four
states and refusal evidence. The template owns contributor prompts, scoped Agent
rules own the pre-PR interaction, and the body checker reports findings through the
existing reconciler. Public conversation links are no longer limited to Lody.
Existing external PRs acquire the same findings on their next reconciliation.

Implementation PR: [#855](https://github.com/LodyAI/Lody/pull/855).

## Validation and limits

Behavioral tests cover complete and omitted disclosure, all status branches,
invalid links and reasons, missing/misplaced refusal evidence, and the reconciler's
attention state. Fixtures are synthetic. No real conversation is committed.
Full workspace check and format commands were attempted but could not complete in
the dependency-free worktree (`tsgo` and `oxfmt` missing). Changed files receive a
separate formatter run. Link accessibility and refusal authenticity remain reviewer
judgments; no network fetch or automatic publication is introduced.

Documentation checking reports the same 34 baseline broken links into uninitialized
ACP submodules, with no new errors. All 108 GitHub script tests pass.
