# Shared conversation link replaces PR handoff fields

Status: implemented
Translation: current

[中文](2026-09-17-shared-conversation-pr-handoff.zh.md)

## Abstract

The pull request Context handoff no longer asks authoring Agents to fill nine
per-field summaries and review checklists. It keeps the verbatim original
prompt as the required evidence and adds an optional `### Shared conversation`
slot for a public link to the published Lody conversation, which carries the
complete authoring context when it exists. For a fork-based pull request an
Agent asks its user to publish the conversation first; publication always
requires the user's confirmation in the app.

## Decision

`### Instructions for reviewing agents` and `### Authoring context` were
removed from `PULL_REQUEST_TEMPLATE.md`. Their required fields duplicated what
the authoring conversation already records, and the filled values decayed into
boilerplate that reviewers could not verify against the actual session.

`### Shared conversation` now closes the Context handoff block, directly after
`### Original user prompt`. The original prompt stays as the required verbatim
evidence because a share link can be revoked while the PR body is permanent.

The section is optional: authors delete it entirely when no shareable
conversation exists, rather than declaring an absence in a required field. The
automated check binds only external fork PRs — the population least likely to
hold a Lody share — while conversation sharing is still a draft, in-progress
cutover. Enforcing the field there would add friction without covering the
Agents the rule targets; the Agent-facing obligation lives in
`.github/AGENTS.md` instead.

Publication follows [conversation sharing](../../../../specs/session-sharing.md):
an Agent may request it through its tools, but only the user confirms in the
authenticated app. The scoped rule therefore reads "ask the user before opening
a fork-based PR" — the handoff block is external-only, so same-repository work
never prompts for a share — and it forbids inventing a share URL.

## Enforcement

`check-pr-body.mjs` leaves `### Shared conversation` unvalidated; inside the
context-handoff markers only `### Original user prompt` remains required. The
per-field validators were removed with their sections. Same-repository PRs sit
outside automated enforcement, and the publish-request rule targets only
fork-based PRs as well.

## Verification

`node --test` over the `.github/scripts` suites covers the updated valid
fixture and omission of the optional section. No live pull request has
exercised the new contract yet.
