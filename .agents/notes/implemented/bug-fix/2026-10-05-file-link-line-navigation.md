# First-click file-link line navigation

Status: implemented
Translation: current

[中文](2026-10-05-file-link-line-navigation.zh.md)

## Abstract

A file link carrying a line number could open the session editor at the top on
the first click and reach its target only on a second click. The navigation moved
the viewport but left Monaco's cursor at line 1, allowing initial language and
wrapped-line layout work to override the pending scroll. Navigation now moves the
cursor to the target and reveals it immediately. Its range decoration uses
Monaco's themed `rangeHighlight` class instead of custom classes that had no CSS.
The installed app reproduced the failure; real Storybook and isolated Monaco
checks verify the source fix, not a rebuilt desktop release.

## Decision and evidence

- Keep ownership in `SessionMonacoEditorController.applySelectedLines`; the
  Markdown parser, viewer-tab line fields, and repeat-click request already carry
  the correct target. No timer, mount retry loop, or duplicate navigation state is
  needed.
- Reproduction used a synthetic 6,600-line model with wrapping, initial widths
  0/20/280/500px, a resize to 500px, and language setup after the line request.
  Before the fix, the narrow initial layouts lost the first reveal; a subsequent
  external text update could also restore the line-1 cursor. The same four cases
  pass with the target cursor and immediate reveal.
- The old `lody-session-monaco-selected-line` and gutter class names had no style
  definitions in the checkout. Monaco already supplies theme-aware range paint;
  reuse it rather than adding another theme mapping or stylesheet.
- Explicit link navigation does not focus the editor or modify file contents.
  Moving its caret is intentional: later editor actions start at the referenced
  line. Ordinary manual scrolling is not forced back to the link target.

## Validation and limits

The running desktop reproduced first-click-at-top, second-click-at-target, and
missing highlight. A temporary browser harness ran the real controller and React
viewer with Monaco 0.55.1, substituting unrelated host integrations. It checked
initial navigation, light/dark paint, resizing, retargeting, repeat navigation,
and the controller's text-update selection restoration. The owning browser suite
now includes the synthetic `LineAnchors` story and behavioral regression.
Its new case passes in that harness and fails against the original controller's
line-1 caret. The final isolated run passed six browser cases.

A standalone validation clone with the locked dependencies and public submodules
also passes the new regression against actual Storybook and UI components,
workspace typechecking, type-aware lint, and formatting. Documentation checks pass
with 64 existing size warnings and no errors. A rebuilt desktop acceptance run
remains unverified.

The full `pnpm check` reaches tests but is not green in this environment. An
unchanged CLI test expects an SSH GitHub remote while Lody's Git wrapper returns
`lody-github::owner/repo.git`; other unchanged CLI/component tests time out or
miss a stall-profile deadline. These failures are outside this fix's scope.

## Related ownership

- [Bug report](https://github.com/LodyAI/Lody/issues/1253)
- [Pull request](https://github.com/LodyAI/Lody/pull/1254)
- [File-link intent](../../../../specs/local-file-link-actions.md)
- [File-surface implementation](../../../docs/sessions-file-surfaces.md)
- [Earlier file-link context-menu decision](../feature/2026-09-17-markdown-file-link-context-menu.md)
- [Controller](../../../../packages/components/src/lib/session-monaco-editor-controller.ts)
- [Browser regression](../../../../packages/components/tests/e2e/code-collab-stories-smoke.spec.ts)
