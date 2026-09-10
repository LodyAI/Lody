# DeepSeek Harness user settings

Status: draft
Translation: pending

## Behavior

Users can configure settings-aware Harness plugins in `settings.yaml` under
`DSH_HOME`, defaulting to `~/.dsh`. Lody's built-in DeepSeek ACP composition must
mount the upstream file settings provider and preserve the user's document.
Absent settings retain composition defaults. Malformed documents fail startup with
an error; the host must not silently overwrite or discard them.

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
