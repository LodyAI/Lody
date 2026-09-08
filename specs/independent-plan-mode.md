# Independent Plan mode

Status: draft
Translation: pending

A user can plan with the same approval policy they use for implementation.
Codex, Kimi, Grok, and supported DeepSeek Harness presets expose one boolean
`plan_mode` config option defined by `acp-extension-core`. Claude retains its
permission-based Plan selector.

Switching Plan changes planning intent only and preserves the selected approval
and sandbox settings. Plan does not by itself guarantee read-only execution;
provider-native restrictions still apply. The UI must not represent an absent
capability as a usable toggle. DSH advertises it only while its Agent composition
provides the Plan service, including after preset changes.

Use ACP `session/set_config_option` and config snapshots/updates for transport.
Provider wrappers translate to native runtime APIs and recover the state from
native persistence. Legacy stored configuration is translated only when the
current target advertises the new option; an explicit boolean takes precedence.
Frozen historical Turns are not rewritten. Executing a plan sets the next Turn's
Plan value to false while preserving its permission selection.

## Evidence and validation

- [Core contract](../packages/acp-extension-core/src/plan-mode.ts)
- [Semantic selection](../packages/shared/src/acp-run-config.ts)
- [Decision and rollout](../.agents/notes/implemented/architecture/2026-09-08-independent-plan-mode.md)

This revision records requested intent, not human approval of the written Spec.
