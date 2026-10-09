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

Lody's built-in DeepSeek ACP composition must
mount the upstream file settings provider and preserve the user's document.
Absent settings retain composition defaults. Malformed documents fail startup with
an error; the host must not silently overwrite or discard them.

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
Settings updates are observed by the provider, but ACP catalogs remain scoped
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
