# Prompt Shortcut composer integration

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/575

## Abstract

Prompt Shortcuts add frozen inline invocations to the composer while the main
branch introduces submission ownership and stable textarea hydration. Their
integration keeps the existing submission lifecycle and window owner behavior,
and preserves Shortcut preparation cancellation and identity-scoped recovery.
Accepted submissions must clear only their own Shortcut checkpoint, including
when completion arrives after switching composers. Live dependency resolution
and gateway end-to-end behavior remain unverified.

## Decisions

- `MainLayout` retains workspace window ownership for singleton background work
  and mounts one readiness- and developer-gated Shortcut provider.
- Session submission uses `useComposerSubmission`; Shortcut compilation runs
  before the existing accepted-message boundary. Ordinary draft owners remain
  responsible for text and ordinary mention persistence.
- Mention preparation keeps a generation ticket, independent of query text.
  Main's stable textarea and hydration reset coexist with identity changes that
  retire pending Shortcut preparation. Unavailable Role candidates and exact
  unavailable Shortcut matches remain disabled with reasons.
- Clearing only the ordinary draft after a retired submission leaves an old
  Shortcut checkpoint eligible for empty-composer recovery. Cleanup therefore
  needs the submitted checkpoint's ownership, not text equality or an
  unconditional deletion that can erase a replacement invocation.

## Verification limits

The merge is checked with component and shared tests, workspace type checking,
formatting, i18n and boundary checks. The outer workspace's affected-check
wrapper is independently blocked by its existing indexed OSS revision mismatch.
Production mobile bundling previously exhausted the Node heap; a complete
production build and real gateway Web/Electron validation remain unverified.
