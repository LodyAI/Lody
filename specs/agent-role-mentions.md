# Agent Role mention discovery

Status: draft
Translation: pending

## Behavior

In every composer, including plain chat, GitHub projects and Local Projects, a
user can mention a Role on any authorized machine. A Role on another machine
than a Local Project or local worktree cannot reach that filesystem, so it runs
as an independent Session on its own machine rather than as a child Session.
Agents dispatching Roles reach the machines the executing machine's owner may
use, never more than the human driving the Turn may use.

The Role menu lists every Role readable in the current workspace, including
unavailable and loading Roles. It preserves ownership and sharing permissions;
it does not expose another user's private Roles. Available search matches come
first, followed by disabled matches. Disabled rows explain their state below
the name: checking availability, machine inaccessible/offline, or binding
missing or mismatched.

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
