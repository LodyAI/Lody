# Skill mention triggers

Status: draft
Translation: current

[中文](skill-mention-triggers.zh.md)

Typing `$` or the Chinese fullwidth yuan sign `￥` opens the same Skills menu,
including within a prompt. Both prefixes support the same query filtering,
source availability gates, and provider directory restrictions.

Selecting a skill replaces the trigger and query with the canonical `$skill-name`
mention. Its stored range, hydration, and before-send expansion follow the existing
skill path. Dismissing the menu leaves the typed text unchanged; an unselected
`￥skill-name` is ordinary text, not a skill reference.

## Evidence

- [Composer and selection tests](../packages/components/tests/combined-mention-textarea-activation.test.tsx)
- [Menu routing](../packages/components/src/components/mentions/mention-registry.ts)
