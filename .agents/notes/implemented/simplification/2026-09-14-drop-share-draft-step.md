# Drop the separate stale-draft step from sharing

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/682

[中文](2026-09-14-drop-share-draft-step.zh.md)

## Abstract

A share draft that outlived its editor has no usable upload credentials, so the
only possible next step is to revoke it and publish a new copy. The dialog used to
show a dedicated unfinished-draft screen whose single action discarded the draft
and returned to setup for a second click. The setup screen now renders directly,
and the publish action revokes the stale draft before it captures and begins the
new deployment. Opening the dialog still changes nothing, and the server's
"revoke before a new copy" rule is preserved.

## Decision

`session-share-manager.tsx` drops the `stale-draft` step and its three copy keys.
`use-session-share-management.ts` adds an unwrapped `revokeDeployment` and calls
it from inside the publish `run` before `capture`, only when no retry package
exists. The retry path is unchanged: a pending publication reuses its frozen keys
without a revoke.

The trade-off is that the human sees one button, "Share conversation", instead of
"Discard and start over", and never learns that a previous attempt existed. That
attempt was never published and its credentials are unrecoverable, so revoking it
is the client's only correct action. Revoking when the dialog opens was rejected:
it would mutate state without a human action and briefly show the post-revoke
notice for a link that never existed.

## Verification

`node scripts/check-i18n.mjs` passes after removing the three unused draft keys.
The full `@lody/components` suite passes (462 files, 3519 tests), including the new
hook test asserting the mutation order `revoke`, `beginDeployment`,
`publishDeployment` for a draft, plus `tsgo --noEmit` and oxlint. Full workspace
`pnpm check` was not run.
