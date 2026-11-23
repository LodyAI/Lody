# Devbar enablement always includes agent and terminal access

Status: implemented
Translation: current

[中文](2026-09-23-devbar-agent-access-merged.zh.md)

Partially supersedes the secondary-gate part of the
[Devframe Hub UI decision](../feature/2026-09-16-devbar-hub-ui.md).

## Abstract

The Devbar Hub used to boot without agent-facing tools; a second `Agent and
terminal access` switch restarted it with the aggregate MCP endpoint and the
Terminals add-on. In practice Devbar is opened to drive exactly those tools, so
the extra gate added a Hub restart and a hidden third state without changing who
could reach the capability. Enabling Devbar now always starts the Hub with MCP
and Terminals, and the secondary control plus its `agentAccess` IPC field are
removed. The loopback trust boundary, the per-process token, and the Terminals
"no arbitrary commands" limit are unchanged; the privileged interactive shell
now follows the Devbar switch alone, which is the intended trade-off.

## Decision and evidence

`DevbarControlInput` drops `agentAccess`; the wire contract between the Settings
renderer and main is now `{ enabled }`. `startDevbarDevframe`
always mounts `plugin-terminals` and the Hub's aggregate `mcp` endpoint, so the
capability set no longer varies after boot and `setDevbarControl` no longer
restarts the Hub for a flag change. Settings removes the secondary switch and
shows the agent connection endpoints whenever the Hub is running. Stopping
Devbar still closes the listener and removes both capabilities.

The same cleanup pulls `warmupEnabled` out of the devbar control message into
dedicated `getWindowWarmup`/`setWindowWarmup` IPC. The auxiliary-window warm
pool is unrelated to diagnostics — it had only reused the single developer
control channel, and every `setDevbarControl` call unconditionally reloaded the
main window, so toggling warmup reloaded the app for no reason. The pool's
metrics still flow into the Devbar snapshot (`warmPool`), which is the
legitimate half of the coupling: the Devbar remains its observability surface.

The alternative — keep the gate but default it on — was rejected: a default-on
kill switch nobody reaches still implies a safer default posture, while adding a
third config state and a Hub restart path for a capability that is the reason
Devbar exists. The genuine cost of merging is that `Open Devbar` now immediately
exposes a loopback MCP endpoint whose Terminals add-on grants interactive local
shell sessions to trusted callers; the earlier design let a developer run
diagnostics-only. That exposure stays inside the unchanged boundary —
loopback-only binding, the Origin allowlist plus per-process token for opaque
origins, `allowArbitraryCommands: false`, and agent-authored Lody MCP entries
still requiring review in trusted UI/CLI — so the only widened surface is one
fewer consent click for the local user.

## Verification

`parseDevbarControlInput` and `initialDevbarControl` tests updated; the enabled
Hub's MCP/Terminals surface is the same composition code as before, so no new
runtime validation was added. See the
[Desktop performance bar Spec](../../../../specs/desktop-devbar.md) for the
current guarantee.
