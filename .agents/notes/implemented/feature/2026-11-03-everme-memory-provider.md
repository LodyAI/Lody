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

Enforcing the local-only rule in Settings alone was rejected: the relay reaches the
daemon whatever the page shows.

## Consequences

Agents that read an isolated configuration home, such as Codex account profiles, do
not see a connection made in the default home. A running session picks up a new
connection only after its agent process restarts.

## Verification

`packages/components/tests/memory-setting.test.tsx` covers the Settings states that
Nowledge Mem shares with the new layout. It also covers preserving an active EverMe sign-in through transient errors until approval
or expiry. `apps/cli/src/lib/memory-providers.test.ts` covers connection and disconnection
budgets including the initial probe. Real EverCLI authentication and the relay refusal
remain unverified by these tests.
