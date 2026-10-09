# DeepSeek Harness user settings

Status: draft
Translation: current

[中文](deepseek-harness-settings.zh.md)

## Behavior

Users configure model routes in `settings.yaml` under `DSH_HOME`, defaulting to
`~/.dsh`. The Harness 0.2 ACP profile reads legacy `llm-deepseek` and `llm-pi-ai`
sections into the corresponding native provider Config schemas and retains
`agent-presets.default` plus user preset identities under `.agent-presets`.
The profile must not invoke upstream's automatic settings migration: renaming the
shared document and importing it into a generated profile would lose durable
configuration across profile upgrades. Absent settings retain defaults; malformed
documents reject ACP initialization without changing the source file.

An unavailable `agent-presets.default` must not strand a session when the standard
preset is usable. At ACP session creation, preserve a usable default, including
custom presets; otherwise select the usable `standard` preset and log a warning.
Persist and return the actual selection without rewriting user settings. This
also applies when the host creates a replacement connection for an existing
conversation. Explicit preset switches remain strict. If neither the configured
default nor `standard` is usable, fail with repair guidance before creating an
Agent; do not choose an arbitrary composition or change permission settings.

The upstream plugin owns configuration schemas and override semantics. In
particular, `llm-deepseek.models` replaces the local catalog array in full.
Settings are read at startup and ACP catalogs remain scoped
to a connection: users refresh capabilities and open a new connection to obtain
updated choices. This does not promise live selector updates in existing sessions.

An explicit `DEEPSEEK_BASE_URL` retains endpoint-driven model discovery. Local
catalog additions are not merged into the endpoint's `/models` response by this
change. Credentials remain host environment inputs, and generated compositions
must not embed them. No product UI or telemetry service is introduced.

## Evidence

- [Extension composition](../packages/acp-extension-dsh/src/profile.ts)
- [Extension settings documentation](../packages/acp-extension-dsh/README.md)
- [Host launch wrapper](../apps/cli/src/agent/deepseek-harness-runtime.ts)

This revision records the requested integration as a draft; it has no linked
human approval of the specification revision.
