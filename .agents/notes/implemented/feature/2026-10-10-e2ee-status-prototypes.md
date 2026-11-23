# Presentational encrypted-workspace status prototypes

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1400

[中文](2026-10-10-e2ee-status-prototypes.zh.md)

## Abstract

Signing in, receiving approval, obtaining keys and loading complete content are
different conditions. Two small controlled components make those differences and
per-workspace recovery results inspectable in Storybook. The caller owns every
state and action outcome, including the affected scope of an error. This provides
UI review material without enabling encryption or claiming a recovery service exists.

## Decision and boundaries

Reuse the existing Card, Button, i18n, StyleX and Storybook facilities instead of
introducing a wizard engine or changing global runtime services. The scope is
[the status components and preview](../../../../packages/components/src/components/e2ee/README.md);
there is no product entry point, dependency change or backend integration.

The recovery file unlocks a cloud encrypted recovery library, with an independent
recovery identity per workspace. Saved material is distinct from a recovery check
for a particular key update. Later updates are not silently marked verified.
Account login and button activation never imply permission or key possession.

Per-workspace result changes have a separate, initially empty polite live region.
Compare committed results by ID, not name or array order. Only changed state or
verified key-update evidence is announced, with the workspace name; new IDs seed
the baseline. Reordering and equivalent props leave its DOM unchanged. Distinct
changes with identical text replace the child node so same-name workspaces do not
hide each other's updates. This is notification state only: it changes neither
focus nor the caller's overall partial/pending state.

The single-document versus workspace-wide failure policy remains unresolved.
Examples show both caller-provided scopes and label the decision as pending.
Recovery-list partial completion does not select that error policy. No cryptographic,
all-platform Beta, durable-progress or production guarantee changes in this work.

```text
Storybook caller (synthetic state and explicit failed result)
  -> E2eeAccessStatus(state, scope, pending, onAction)
  -> E2eeRecoveryStatus(state, workspaces, pending, onAction)
       -> existing Card / Button / translations
button -> caller intent only -> caller supplies next state
```

## Evidence and limits

Base: `a79613633c3cb19e0d31a693c92331c4da1b769c`.
Reproduction commands and preview paths live in the component README. The browser
suite covers English/Chinese, narrow/desktop layout, accessible structure and
keyboard retries. The pending button stays focusable but cannot activate; the
failure remains until the caller changes it. No timers or real data are used.

Initial validation: 8 browser tests passed; the existing components suite passed 556 files /
5010 tests. Component typecheck, `pnpm check:quick`, `pnpm format`, scoped Oxfmt
and `pnpm run docs check` passed. Light desktop and dark narrow screenshots were
visually inspected, including the partial recovery card.

`pnpm check` did not pass in the restricted environment: shared IPC/host-lease
socket binding reported `EPERM`; CLI preview and broker-auth tests also failed.
All four affected files passed when rerun with local socket/process access. This
does not establish a full green repository run; the remaining chain, including
Electron tests, was not completed. Reproduce those environment checks with:

```sh
NODE_ENV=test pnpm --filter @lody/shared test tests/local-ipc.test.ts tests/local-cli-host-lease.test.ts
NODE_ENV=test pnpm --filter lody test src/preview/preview-service.test.ts src/session/worktree/worktree-manager-broker-auth.test.ts --maxWorkers=2
```

The announcement follow-up starts at `9b4e10996185b74514185194c3560389ac8fc0a1`.
Four focused browser cases passed (two languages, result changes and recovery
keyboard behavior), including live-region MutationObserver evidence for separate
same-name IDs, initial silence, reordered/equivalent props and a changed verified
key update. Component typecheck, quick/static, format and docs checks passed.
The unchanged visual/full local test matrices were not rerun for this follow-up.
Use the focused command in the README; CI runs against the new commit separately.

Actual VoiceOver/NVDA speech, 200% zoom, native platforms, real recovery files, services and
persistence are not established by these tests. Production integration and the
pending failure policy require separate work and review.
