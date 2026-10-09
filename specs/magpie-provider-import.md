# Local Magpie provider import

Status: draft
Translation: current

[中文](magpie-provider-import.zh.md)

Opening a Magpie import link in the desktop opens one global confirmation dialog,
independent of the current page. Users select Claude, Codex, Pi and/or DSH with
checkboxes; available targets start selected. Confirmation creates new builtin
Providers named `Claude-magpie`, `Codex-magpie`, `Pi-magpie`, and `DSH-magpie` only
on the current desktop's local execution machine. A selected remote machine never
participates. Existing providers, roles, account bindings and native settings stay intact.

## Public link

`lody://provider/import?v=1&data=<base64url UTF-8 JSON>` carries this bounded envelope:

```json
{
  "kind": "custom",
  "id": "magpie",
  "name": "Magpie",
  "auth": { "method": "apiKey", "apiKey": "magpie-lody" },
  "endpoints": [
    { "protocol": "anthropic-messages", "baseUrl": "http://127.0.0.1:3425", "targets": ["claude-code"], "modelsUrl": "http://127.0.0.1:3425/v1/models" },
    { "protocol": "openai-responses", "baseUrl": "http://127.0.0.1:3425/v1", "targets": ["codex"], "modelsUrl": "http://127.0.0.1:3425/v1/models" },
    { "protocol": "openai-chat", "baseUrl": "http://127.0.0.1:3425/v1", "targets": ["pi", "dsh"], "modelsUrl": "http://127.0.0.1:3425/v1/models" }
  ]
}
```

A subset of endpoints/targets is allowed. This is a local Magpie-specific contract,
not arbitrary Provider or secret import. Only literal loopback HTTP hosts
`127.0.0.1`, `localhost`, and `[::1]` are accepted, with one shared origin and exact
API paths. `magpie-lody` is a public usage attribution token, not an upstream key.
Reject vendor credentials, commands, arbitrary environment fields, unknown versions,
duplicate parameters/targets, malformed payloads and links over 8 KiB. URLs never
select a machine, workspace, model, permission mode or executable.

Common links stay in the OS-selected Lody installation, including OSS. Opening a
link only stages a request in memory; it never writes settings or calls the gateway.
Malformed imports show a redacted error. A newer valid request replaces the staged
one. On boot, the request waits for the workspace and local machine to become ready.
Unsupported/disabled local agents cannot import, and there is no remote/cloud fallback.
The local daemon must advertise `magpieImport` v1 and `providerSetup`; Pi additionally
requires `builtinPi`. Successful partial writes survive failure; retry skips providers
already bound to the same gateway and runtime. No existing provider is overwritten.

## Runtime ownership

The renderer generates only known environment mappings and persists through the
existing Machine Flock writer. Managed runtimes use the existing background setup
queue; DSH uses its existing non-managed creation path. Import success means the
configuration is durable, not that a model request has succeeded. Providers exposes
managed setup progress and errors. Changes to the workspace/machine/request stop
remaining writes without undoing already durable configurations.

`LODY_MAGPIE_GATEWAY` selects daemon-owned preparation. Each launch checks
`/api/hello` and reads a bounded `/v1/models` catalog with a timeout and no redirects.
Unavailable, invalid or empty catalogs fail explicitly. The gateway origin participates
in capability-cache identity; normal refresh starts a new live probe. Running agents
are not hot-reloaded when Magpie's model catalog changes.

- Claude receives its Anthropic endpoint/token and `CLAUDE_MODEL_CONFIG` catalog.
- Codex receives a Responses provider plus a generated native model catalog in a
  Lody-owned, gateway-scoped Codex home. It does not reuse a ChatGPT account binding.
- Pi receives a generated `models.json` in an isolated Lody-owned Pi profile, using
  OpenAI Chat Completions. Native global profile extensions/settings are not imported.
- DSH receives `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`; its adapter discovers models.

All vendor credentials stay with Magpie. Newly started runtimes default to the first
catalog model; explicit session selections use the normal ACP startup contract.

## Integration boundary and evidence

Magpie must be running on this same machine. Adding a Lody row to Magpie's Agents
page requires a separate upstream adapter; this repository implements the receiving
contract and does not change Magpie. No status API or direct database-edit contract
is introduced in this revision.

- [Import parser and mappings](../packages/shared/src/magpie-import.ts)
- [Runtime preparation](../apps/cli/src/agent/magpie-runtime.ts)
- [Decision and validation](../.agents/notes/implemented/feature/2026-10-09-magpie-provider-import.md)
