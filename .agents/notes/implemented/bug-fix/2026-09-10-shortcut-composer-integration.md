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

## Ablation findings

The product no longer has variables or expand-and-edit. The old standalone
prototype modeled both and had no product consumers. Removing that prototype,
its dedicated story/model tests, and unused editable-annotation/replacement APIs
preserves the real settings, menu, chip and mobile stories.

`compileShortcutPrompt` is the production composer compiler; the second
`expandShortcutComposer` implementation had only test consumers. Its useful
stale/duplicate-range checks now test the production boundary. Likewise, publication
uses the local store's fresh document, not `fromPublishedState`; runtime tests
exercise private-history exclusion and late acknowledgements directly.

| Experiment                                                           | Result                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Remove prototype                                                     | 26 product regression tests and component types pass           |
| Remove replacement/annotation API                                    | 36 primitive/editing/modal tests and types pass                |
| Remove duplicate compiler                                            | 40 real send-path tests and shared snapshot tests pass         |
| Remove unused publication helper and constant internal loading state | 35 real storage/sync tests and shared types pass               |
| Inline the identical Shortcut range predicate                        | 44 draft/submission tests and component types pass             |
| Disable semantic history temporarily                                 | Undo loses the frozen invocation; one test fails               |
| Accept stale preparation temporarily                                 | Edit-away/back and dismissal insert late chips; two tests fail |

The negative controls were restored. Account/workspace fencing, preparation,
semantic history, ordered writes and checkpoint ownership remain required.
Duplicate mention rationale now lives only in the existing mention pipeline
article, and Settings rules have one scoped owner.

## Verification limits

Checks use the outer dependency installation with test environment variables
isolated. Its affected-check wrapper remains blocked by the existing indexed OSS
revision mismatch; the standalone public E2E package is not in that dependency
graph. Production mobile bundling previously exhausted the Node heap. Live
dependency resolution, full production builds and gateway E2E remain unverified.
