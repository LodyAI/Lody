# Menu typography

Status: draft
Translation: current

[中文版](menu-typography.zh.md)

## Scenario

A person opens a session menu or a composer picker and scans peer choices.
Ordinary options should carry the same visual priority across these surfaces.

## Responsibilities

Menu labels use regular weight (400), including submenus, checkbox and radio
options, context menus, and menubar labels. Composer picker and mention menus
follow the same rule. Selection and hover are conveyed by marks and fills;
selecting an option does not make its label heavier.

Group headings may retain medium weight (500), and matched characters in a
mention search retain their emphasis. Buttons, field triggers, search inputs,
and popup prose keep their own typography roles.

The shared menu primitive owns its default weight. Composer surfaces that
render picker or mention rows own the equivalent declaration, without changing
placement, row spacing, keyboard navigation, or selection behavior.

## Evidence

Implementation: [popup surface](../packages/ui/src/popup/surface.ts),
[composer surface](../packages/components/src/components/shared/composer-surface.ts),
and [mention surface](../packages/components/src/ui/mention/mention-surface.ts).

Decision and validation:
[menu typography note](../.agents/notes/implemented/bug-fix/2026-09-30-menu-regular-weight.md).
