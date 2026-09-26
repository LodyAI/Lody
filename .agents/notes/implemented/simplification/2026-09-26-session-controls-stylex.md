# Keep shared session controls on StyleX surfaces

Status: implemented
Translation: current
PR: [#1017](https://github.com/LodyAI/Lody/pull/1017)

[中文](2026-09-26-session-controls-stylex.zh.md)

## Abstract

The workdir mode selector, inline worktree pill, and session relation card still
owned their appearance through Tailwind classes. Their visual rules now live in
component-local StyleX definitions, while the menu's narrow width is a formal
`@lody/ui` compact variant instead of a class override. A read-only mode is
presented as inert text rather than a disabled control. Thirty-two fixed
Playwright light/dark scenes had zero changed pixels; that result covers the
sampled states, not every host or display scale.

## Decision

The session relation card owns its row, icons, truncation, and hover treatment;
the workdir file owns the selector's content and checkbox pill. The chat
landing composer uses the pill's explicit `surface="context"` variant instead
of passing Tailwind visual overrides. Both components use
product-mapped `@lody/ui` label and separator tokens. The existing `--muted`
and `--hover` films have no pixel-equivalent semantic token, so their exact
theme CSS variables remain inside StyleX declarations until a matching token
is designed. Radius and horizontal padding values without exact scale matches
likewise retain their measured pixels. This is a narrow compatibility bridge,
not a new palette.

The interactive mode selector continues to use `@lody/ui` Button and Menu.
The old 180px menu floor was a Tailwind override of the primitive's 200px
default; `Menu.Content width="compact"` now owns that reusable two-choice
variant. Its rows still grow for longer content. The previous disabled Button
was visually raised to 80% opacity by a Tailwind override, contrary to the
primitive's 45% disabled rule. Once a session locks its mode, the label is not
an action, so an inert, tooltip-named span preserves the 80% appearance and
removes a misleading keyboard target. This follows the
[menu family decision](../feature/2026-09-11-ui-menu-primitives.md) without
restyling the primitive from a caller.

## Verification

Playwright captured the original Tailwind and new StyleX revisions in the same
Storybook fixture at 800 × 760, device scale 1, with loaded fonts, reduced
motion, disabled animations, and repeated screenshots until stable. The 32
light/dark pairs include both menu states, selecting Worktree, unavailable and
read-only modes, standalone and composer-context checked/disabled pills, direct relation cards, and an
in-conversation card. Every pair had zero changed RGBA pixels. UI and
components typechecks passed in a verification checkout with ACP dependencies;
the full `@lody/ui` suite passed (297 tests), as did the relation-card suite
(9 tests). The isolated primary worktree lacks ACP submodules, so its own
component typecheck and repository-wide checks cannot establish a full green
result; GitHub CI is the full-check authority for this PR.
