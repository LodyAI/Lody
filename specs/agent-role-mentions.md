# Agent Role mention discovery

Status: draft
Translation: pending

## Behavior

In plain chat, a user can mention a Role on any authorized machine. A GitHub
project can also use another machine when its file source is not bound to a
local worktree. Local projects and GitHub file sources with a local worktree
require the Role to execute on that filesystem's machine.

The Role menu lists every Role readable in the current workspace, including
unavailable and loading Roles. It preserves ownership and sharing permissions;
it does not expose another user's private Roles. Available search matches come
first, followed by disabled matches. Disabled rows explain their state below
the name: checking availability, machine inaccessible/offline, binding missing
or mismatched, or execution outside the current work context. Binding failures
take precedence over work-context restrictions.

The dedicated Role list shows the full readable catalog. Aggregate search keeps
its existing per-category cap, applied after availability ordering. Search
continues matching Role names and their derived mention tokens.

Disabled Roles cannot be selected with mouse or keyboard. Text hydration and
before-send expansion also require current availability; a stale mention stays
plain text and creates no Role dispatch instruction. Exact machine/config
bindings and Operation acceptance remain governed by the
[shared contracts](../packages/shared/AGENTS.md).

## Evidence

- [Context, availability and expansion](../packages/components/src/components/mentions/mention-agent-role-source.ts)
- [Candidate mapping](../packages/components/src/components/mentions/mention-registry.ts)
- [Menu rows](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [Behavior tests](../packages/components/tests/agent-role-mention-source.test.ts)
- [Selection tests](../packages/components/tests/mention-two-level-menu.test.tsx)
