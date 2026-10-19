# DeepSeek Harness user settings

Status: draft
Translation: current

[中文](deepseek-harness-settings.zh.md)

## Behavior

Each Lody DSH Provider uses `<Lody data root>/dsh/providers/<encoded Provider ID>`
as its `DSH_HOME`. Renaming it keeps that directory; another Provider gets a different
directory. Users can configure settings-aware plugins in its `settings.yaml`.
The Provider details show `Configuration path: <absolute YAML path>` for
`profiles/lody-acp/cordis.patch.yml`, using the owning machine's published data root
and `dshProviderIsolation: 1` capability. Older machines show no inferred path.

Lody creates this user patch only when missing. Startup, concurrent launches and
adapter upgrades preserve it and `settings.yaml`; generated host layers update
separately. The final host layer enforces the ACP entry, session storage paths and
disabled product/telemetry services without resetting user model routes. Existing
native sessions and the query database remain in the previous DSH session root.
Old global settings and fingerprinted profiles stay untouched; no ambiguous legacy
profile is automatically selected or copied into all Providers. Users move desired
customizations to the displayed path. Magpie's default global DSH scan does not
automatically discover these private homes. Lody import still configures its
Provider environment directly.

The Harness 0.2 ACP profile reads legacy `llm-deepseek` and `llm-pi-ai`
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
change. For the official API, new host configurations use
`https://api.deepseek.com/anthropic`. Existing official root and `/v1` URLs must
continue working without manual reconfiguration: the generated profile resolves
known official aliases to the Messages root before provider construction while
preserving settings-over-environment precedence and leaving stored configuration
untouched. Official model discovery uses `https://api.deepseek.com/models`, and
both old and new official URLs retain official pricing. Custom URLs are preserved;
this compatibility does not convert a Chat-only gateway to Messages.
Credentials remain host environment inputs, and generated compositions
must not embed them. No product UI or telemetry service is introduced.

## Evidence

- [Extension composition](../packages/acp-extension-dsh/src/profile.ts)
- [Extension settings documentation](../packages/acp-extension-dsh/README.md)
- [Host launch wrapper](../apps/cli/src/agent/deepseek-harness-runtime.ts)

This revision records the requested integration as a draft; it has no linked
human approval of the specification revision.
