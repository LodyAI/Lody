# ACP run configuration safety

Status: draft
Translation: current
Language: [中文](acp-run-config-safety.zh.md)

A user picks a permission mode, such as Plan or read-only, and a model, then sends a
message. Before the agent starts on the message, Lody must know the agent will run with
no more permission than the user chose. A model switch must not silently widen it, and
Lody must not assume that a setting it requested took effect.

## Order

Lody applies a turn's run configuration in this order: the model first, then ordinary
options such as reasoning effort and Fast, then the independent Plan setting, and the
permission mode last. Switching models can rebuild an agent's other options, including
its permission modes, so nothing set before the switch is trusted to survive it.

## Intent

A turn configuration may omit the permission mode or Plan. The turn then runs under the
latest earlier turn in the same session that set each one. The two are resolved
separately, and an explicit Plan off is kept. Nothing from later turns, such as queued
ones, applies. When a turn switches the model, or the agent does not already report the
inherited setting, Lody sends that setting again.

## Evidence

Only the agent's own report counts:

- **Confirmation**: the complete option list the agent returns for this setting, or a
  `session/set_mode` request that was actually sent and returned successfully.
- **Not confirmation**: an empty acknowledgement, a value Lody filled in itself, or any
  report from before this turn's setting.
- **Asynchronous reports**: they carry no request id, so they can contradict a
  confirmation but never supply one.

## Decision before the prompt

A request is restrictive when a built-in agent's mode is its read-only or Plan mode, or
when Core `plan_mode` is on. A third-party mode is never restrictive, whatever its name.
Built-in modes have a known order from narrowest to widest; any other pair is not
comparable.

| Request | Result | Turn |
| --- | --- | --- |
| Restrictive | Confirmed equal, or narrower | Runs |
| Restrictive | Unconfirmed, failed, not comparable, or contradicted | Stops before the prompt |
| Any | Confirmed wider | Stops before the prompt |
| Not restrictive | Unconfirmed, failed, or not comparable | Runs with a visible warning |

A stopped turn reports the requested and actual values and the model. The user changes
the setting and sends again. Lody does not retry automatically, and there is no one-time
override.

## Open questions

- Whether to offer a one-time "run with the wider mode" acceptance.
- Third-party agents have no ordering; their mismatches only warn.

Evidence: `apps/cli/src/session/acp-session-config-applier.ts` and its tests;
`packages/shared/src/acp-permission-order.ts`. Draft for human review; tests do not grant
approval.
