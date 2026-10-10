# Presentational encrypted-workspace status prototypes

Status: implemented
Translation: current

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

Validation: 8 browser tests passed; the existing components suite passed 556 files /
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

Actual VoiceOver/NVDA speech, 200% zoom, native platforms, real recovery files, services and
persistence are not established by these tests. Production integration and the
pending failure policy require separate work and review.
