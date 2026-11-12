# Lody Mobile

Native mobile clients maintained in the Lody public repository. Read
[iOS rules](ios/AGENTS.md) or [Android rules](android/AGENTS.md) before editing.
Rules both clients share live in [cross-platform rules](docs/rules/cross-platform.md);
both platform indexes link them.

- Keep iOS and Android builds independent of the root pnpm workspace. Run the
  platform commands in [README.md](README.md) from their documented directories.
- Preserve upstream licenses, copyright notices, and the attribution to Innei's
  lody-ios. ChatKit remains a pinned public submodule.
- Platform appearance code and bundled resources live with each native client;
  there is no shared design generator or preview project.
- Mobile may use its public cloud protocol clients. Never import private backend
  implementation, credentials, or captured user transcripts.
- Nested iOS GitHub workflows are retained as upstream references, not active CI.
  Root checks do not replace native build and platform verification.

- Backend origins come from `backend-config.mjs`: optional ignored `.env.local`,
  process environment overrides, production defaults. Both platforms must use
  the same resolver and endpoint-tuple storage namespace, including persistent
  Roost history and pending inputs. Never inject secrets
  or disable TLS validation. See README.md#backend-configuration.

- Native mobile clients do not support encrypted content yet. Keep E2EE workspaces visible with a lock, but block their runtime and sending. Confirm unknown workspace modes through `e2eeWorkspaces:describe` before opening plaintext transport. Retain encrypted mode/genesis observations independently of account/catalog caches across logout and restart; server replies can never downgrade them. An explicit `legacy-unclassified` descriptor admits ordinary workspaces only without mode/crypto fields or retained encrypted evidence. Unreadable encrypted pins fail closed; optional plaintext cache failures never revoke online admission. Mode retries preserve account, credentials and workspace selection. Gate native creation and Outbox persistence before writing plaintext, and exclude blocked workspaces from Share snapshots and attachment uploads.
