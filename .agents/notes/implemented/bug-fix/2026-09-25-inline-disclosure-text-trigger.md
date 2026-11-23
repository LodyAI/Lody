# Inline disclosures in settings forms stay text triggers, not ghost buttons

Status: implemented
Translation: current

[中文](2026-09-25-inline-disclosure-text-trigger.zh.md)

## Abstract

The "Show injected variables" disclosure in the provider dialog sat visually
off the form's text column after the `@lody/ui` migration, because its trigger
became a small ghost `Button` whose `padding-inline` indented the chevron and
label ~12 px past the edge every field shares. Bleeding the button box left by
its own padding aligned the label but pushed the hover/active fill past the
column, which read as a worse defect. The trigger is now a plain text button
like the dialog's other disclosure triggers: content on the column edge, a
colour change on hover, a focus ring only for keyboard focus.

## Cause and decision

Pre-migration the trigger was an inline-flex text button with no padding.
Commit `18f10b65` swapped it for `Button variant="ghost" size="small"`, which
carries `paddingInline: 10px` and a 28px control height. Two alignments are
possible with a padded box — box edge on the column (content indents, the
reported bug) or content on the column (negative margin bleeds the hover fill
left, worse) — and neither matches what the surrounding rows do.

The codebase's other `Collapsible.Trigger` disclosures (`Section`,
`CollapsibleSection`, the session plan bar) are all plain styled `<button>`
elements, not the `Button` primitive. The trigger now follows that pattern via
`styles.injectedTrigger`, restoring the pre-migration caption-strength look
(11px, secondary label colour) and keeping `:focus-visible` as a box-shadow
ring, per the package's ring rules. `styles.answer` still wraps the "Download
agent" secondary button, where the visible box edge is what aligns.
