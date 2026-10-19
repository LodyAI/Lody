# Align the full-width message editor with the user stack

Status: implemented
Translation: current

[中文](2026-10-19-full-width-editor-alignment.zh.md)

## Abstract

In a full-width conversation the user stack is capped at 70% of the column, but
editing a sent message replaced the fitting bubble with a full-width column
whose 800px cap stayed at the inline-start. The editor card therefore ended up
hundreds of pixels left of the metadata and avatar, which sit on the stack's
inline-end. The editing content box now receives `margin-inline-start: auto`,
so the capped column follows the same inline-end edge. Non-editing rows keep
their fitting width, and columns narrower than the cap have no leftover space,
so neither changes.

## Decision and evidence

The row wrapper already switches from `w-fit` to `w-full` while editing, and
the content box keeps `w-full` plus `sm:max-w-[800px]`. Without an auto margin,
a 100%-wide box capped at 800px sits at the inline-start of the wider stack,
while the editor card inside is right-aligned within that 800px box. The StyleX
rule applies only to the editing state; the avatar and metadata remain on the
stack edge.

The `AI GUI/UserMessageEditor--full-width-from-message-edit` story wraps the row
in an inline-size container. The Playwright regression compares the editor
card's inline-end edge with `[data-testid="user-message-metadata"]` at 1800px,
where the 70% stack exceeds the cap, and at 900px as a normal-width control.

## Verification and limits

The Storybook run in the system Chrome build passed at both widths after the
change and failed at 1800px when the style was temporarily removed. The bundled
Playwright browser was unavailable in that environment. The layout was not
exercised in the packaged desktop app. The logical margin follows RTL; mobile
widths use the 28rem mobile stack and were not separately exercised.
