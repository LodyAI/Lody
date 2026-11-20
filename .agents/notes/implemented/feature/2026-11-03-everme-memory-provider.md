# EverMe as an account-scoped memory provider

Status: implemented
Translation: current

[中文](2026-11-03-everme-memory-provider.zh.md)

## Abstract

Nowledge Mem gives each Role its own memory identity, which Lody injects into the ACP
process at startup. EverMe instead holds one memory per account, and an agent reaches
it through the hooks or MCP server that EverCLI writes into that agent's own
configuration. Lody therefore adds EverMe as a provider that connects agents rather
than one that Roles bind, and accepts its setup only from the machine itself. The
trade-off is that a connection lives in the agent's global configuration, so it also
applies outside Lody.

## Decision

- **One account, one memory.** The adapter lists no identities and refuses create and
  update, so there is nothing for a Role to reference.
- **Connected per agent, not bound per Role.** Settings builds its rows from the
  machine's Lody agent configs and maps each to an EverCLI platform; connect and
  disconnect run `evercli plugin install|uninstall`. The Role memory picker omits
  EverMe, and ACP startup injects no environment for it.
- **Set up only on its own machine.** A device-flow approval binds the machine to
  whoever approves it, so a request from another member's device could route this
  machine's conversations into their account. Settings sends EverMe requests only to
  the local machine, and the daemon refuses them on the workspace relay and the
  encrypted feature ingress. Both sides use the one predicate
  `isLocalOnlyMemoryProvider`.
- **Connecting runs as a job on the machine.** A batch costs a login probe, two
  inventories and one EverCLI call per agent, each allowed the runner's 20s, so
  `connect` and `disconnect` start a single-slot job and reply at once, and the panel
  follows it with `connectPoll` the way it follows an install. A second click while a
  batch runs rejoins it, because EverCLI rewrites one shared config per agent.

Enforcing the local-only rule in Settings alone was rejected: the relay reaches the
daemon whatever the page shows.

Fitting a batch inside the 60s local RPC by reserving time for one command and the
final inventory was rejected: once the probe and first inventory together took more
than 19s, even a single agent was deferred, and every retry paid for the same probes
again, so a slow network left the user unable to connect or disconnect at all.

## Consequences

Agents that read an isolated configuration home, such as Codex account profiles, do
not see a connection made in the default home. A running session picks up a new
connection only after its agent process restarts. Because the connection is global,
the notice shown before a machine's first connection says that it also applies when
the agent is used outside Lody.

Lody installs the current `@everme/cli` release rather than a version pinned in its
source, so a Lody build does not fix which EverCLI a machine gets. EverMe publishes
only releases it considers stable, and a pin would leave every Lody build installing
an EverCLI that its backend may no longer serve. The Node.js that Lody provisions
when the machine has no usable npm is pinned by version and checksum.

The install and connect jobs are Promise work held by the provider's closure, and a
process restart forgets them; a poll then answers `failed` and the panel reads a fresh
inventory. A native Effect migration of the provider was assessed and deferred: its
commands go through the deprecated `runCommandTextLegacy` facade with
`getLoginShellEnvLegacy`, and `handleMemoryProviderRequest` is reached from Promise
request handling, so a native unit would need a daemon-scoped provider service owning
these jobs as fibers together with those callers. Until then each job is bounded only
by the runner's per-call timeouts.

## Verification

`packages/components/tests/memory-setting.test.tsx` covers the Settings states that
Nowledge Mem shares with the new layout, and an active EverMe sign-in surviving
transient errors until approval or expiry. `apps/cli/src/lib/memory-providers.test.ts`
covers the connection job answering before EverCLI finishes, connecting when every
call takes most of its budget, rejoining a running batch, and a failed or forgotten job,
as well as the relay refusing every
EverMe request before EverCLI or npm runs, the device flow keeping its device code on
the machine, and the install job with its Node.js fallback.
`apps/cli/tests/machine-runtime-remote-bridge.test.ts` covers the refusal on the
encrypted feature ingress. `apps/cli/src/lib/everme-node.test.ts` covers rejecting a
Node.js archive that does not match the checksum pinned in the source, from the
default source or a mirror. These use fake command runners: authentication against
the real EverMe service and a relayed request from a second device remain unverified.
