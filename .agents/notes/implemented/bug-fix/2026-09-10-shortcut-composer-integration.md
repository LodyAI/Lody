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

## Cleanup and coverage scope

Ablation removed the obsolete prototype, unused editable annotations/replacement
API, test-only composer compiler and publication helper. Negative controls showed
that disabling semantic history loses snapshots and accepting stale preparation
inserts late chips; those protections remain.

The feature is temporary. Its dedicated tests, Storybook stories and additions to
shared test fixtures were subsequently removed to reduce maintenance scope.
General mention preparation/modal and existing composer tests remain. Earlier
ablation results are historical evidence, not a claim of retained feature coverage.

## Verification limits

Checks use the outer dependency installation with test environment variables
isolated. Its affected-check wrapper remains blocked by the existing indexed OSS
revision mismatch; the standalone public E2E package is not in that dependency
graph. Production mobile bundling previously exhausted the Node heap. Live
dependency resolution, full production builds and gateway E2E remain unverified.
