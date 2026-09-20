# Built-in Sorbet and its Provider Center

Status: draft
Translation: current

[中文](builtin-sorbet-provider-center.zh.md)

## Scenario

A user adding an Agent to a Machine can choose Sorbet as a Lody-bundled builtin. The Sorbet form
presents that Machine's connection settings directly, without a separately named Provider Center
heading. A fresh Machine has no custom Provider and does not guess a connection. The user can sign
in with any subscription OAuth Provider advertised by the bundled Sorbet runtime—currently Codex,
Claude, GitHub Copilot, Kimi Code, and xAI—or add a custom OpenAI-compatible or
Anthropic-compatible Provider.

Codex is the recommended connection and becomes the default when it is the first usable connection.
Claude OAuth remains disabled until the user enables it; the other advertised subscription
connections are immediately available for login. Any connected Provider can be selected explicitly.
The selected connection supplies the default model for new Sorbet Sessions.

## Responsibilities

Lody owns the bundled Sorbet revision, the Agent creation flow, Machine routing, secret transport,
process supervision, and the choice applied to a new Session. Sorbet owns Provider definitions,
credentials, models, Session execution, Journals, and the Provider/model recorded in a Session.

Provider Center state belongs to the execution Machine under Lody's Sorbet data directory. OAuth
continues through Sorbet's ACP authentication methods. Provider settings are currently available
only from the desktop app to its process-local Machine bridge; the unauthenticated Workspace Streams
RPC rejects every Provider settings request. API keys must not enter Agent configuration, Machine
Flock rows, Loro documents, prompts, Journals, retained progress, command arguments, or logs. The
local target CLI writes the key through Sorbet's credential store and returns metadata only.

The Machine advertises `sorbetProviderCenter` protocol version 1. Clients must check this capability
instead of inferring support from a CLI release or the presence of Sorbet in their own UI. An older
Machine shows an upgrade/restart requirement and does not offer a configuration action that can only
fail.

## Connection behavior

- Codex OAuth is enabled and recommended on a fresh Machine.
- Claude OAuth is disabled on a fresh Machine and requires an explicit enable action.
- Other subscription OAuth connections come from Sorbet's Provider metadata rather than a separate
  Lody allowlist. The current bundled runtime advertises GitHub Copilot, Kimi Code, and xAI in
  addition to Codex and Claude.
- A fresh Machine has no custom Provider. Adding one requires a name, HTTP(S) endpoint, protocol,
  at least one model, and an API key before it is usable.
- Disconnect and logout act on one Provider. They must not clear unrelated Sorbet credentials.
- Removing a custom Provider is rejected while a saved Sorbet Session or approval reviewer still
  references it.
- Choosing “Use for new sessions” changes the Machine default. It does not change a running Session.

If the saved default is no longer usable, resolution prefers an available Codex OAuth connection,
then another connected and enabled subscription OAuth connection, then an available custom Provider.
Claude is never enabled by resolution. If no connection is usable, Session creation remains blocked
in the Provider settings instead of silently changing Provider or weakening authentication.

Each Sorbet worker receives the resolved default model when it starts. Sorbet records the actual
Provider and model in its Session metadata. Loading or resuming a Session uses that recorded value,
so a later Machine-default change only affects new Sessions. A Provider failure never triggers an
automatic cross-Provider retry. The user must make an explicit, persisted selection before later work
uses another Provider.

## Runtime and durability

Lody starts one Sorbet ACP worker for each live Lody Session. There is no Machine-wide long-lived
Sorbet host. Lody serializes Provider Center mutations through one control queue, and each control
operation runs against Sorbet's public Provider and credential boundaries. Per-Session workers read
Provider definitions at process start; a running or resumed Session keeps its pinned Provider
snapshot.

The bundled control entry and ACP entry use `<lody-data>/agents/sorbet` and honor `LODY_DATA_DIR`.
Provider selection is written atomically with owner-only permissions. Credential mutation uses
Sorbet's cross-process lease. Remote Provider configuration remains disabled until Lody can mint and
verify an authorization token bound to the requester, Machine, exact operation payload, and replay id.

The target Machine resolves its environment or system HTTP(S) proxy into standard proxy variables
before it starts Sorbet. Sorbet installs a proxy-aware global Node dispatcher at its executable
boundary, so OAuth exchange, token refresh, and Provider model requests honor `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` consistently.

An interactive OAuth start may remain open while Sorbet waits for a method choice, URL consent,
form response, or browser code. The matching submit or cancel message must reach that live request
without waiting behind the start operation in the Machine control queue; otherwise both operations
wait on each other and authentication cannot finish. Lody's dedicated authentication client
advertises the versioned `lody.credentialForm` capability because its form responses use the
one-time encrypted Machine RPC path. Sorbet only sends `secret` and `manual_code` prompts over a
form when that capability is present. It waits for URL consent before requesting Pi's fallback
manual code, and Lody keeps the authorization link visible beside that form.

## Evidence

- `packages/shared/src/sorbet-provider-center.ts`
- `packages/shared/src/machine-protocol-capabilities.ts`
- `packages/loro-streams-rpc/src/rpc.ts`
- `packages/loro-streams-rpc/src/machine-rpc-server.ts`
- `apps/cli/src/agent/sorbet-provider-center.ts`
- `apps/cli/src/agent/sorbet-provider-preferences.ts`
- `apps/cli/src/lib/machine-runtime.ts`
- `apps/cli/src/sorbet-provider-control-entry.ts`
- `apps/cli/tests/machine-runtime-acp-authentication.test.ts`
- `packages/components/src/components/settings/sorbet-provider-center.tsx`
- `packages/components/tests/sorbet-provider-center.test.tsx`
- `packages/components/src/components/settings/agent-config-dialog.tsx`
- `apps/cli/scripts/check-sorbet-runtime.mjs`
- `packages/sorbet/packages/node-agent/src/network/http-proxy.ts`
- `packages/sorbet/packages/node-agent/tests/http-proxy.test.ts`

Executed validation: shared, Streams RPC, CLI, and component type checks; local Provider routing,
remote rejection, and Provider settings component tests; the bundled Sorbet lifecycle and Provider Center smoke checks, including
execution through the first Codex OAuth login prompt; and the interactive authentication queue
regression test. On Darwin, the final CLI bundle also completes model-driven parallel Read and Bash
Tools against a synthetic local Provider, applies thinking and permission configuration, recovers a
durable Session after worker `SIGKILL`, and forks from a committed turn into an independent Session.
The synthetic Provider does not exercise a real OAuth account, paid model request, installed desktop
UI, packaged Windows/Linux runtime, or the full external-side-effect failure matrix; those remain
separate production gates.
