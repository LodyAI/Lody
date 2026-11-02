# E2EE UI

Parent instructions apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.

## Status prototypes

- Components are presentational: callers supply states, affected scope and action
  callbacks. Never infer authorization, key possession or global failure policy
  from a click or a single failed item.
- Keep examples synthetic and isolated in Storybook. Do not add production entry
  points or connect cryptographic, authorization or recovery services here.
- Recovery evidence belongs to each workspace and a specific key update, not to
  account login or file creation. See [README](README.md) for preview and checks.
- Announce result changes by workspace ID, including its name. Initial/new rows,
  reordering and unchanged results stay silent; announcements must not move focus
  or imply that the whole recovery completed.

## Local agent approval

The sibling `../e2ee-local-agent-approval.tsx` requires explicit consent and file-custody disclosure. Hide approval without a local credential. Re-prepare on retry; retain consent only for the same session, and require fresh consent for a replacement session. Local status failures must remain retryable. Credentials stay in main; UI consumes availability only.

Offline workspace UI uses same-account pins and preserves ready lists.

## Local terminal availability

The sibling `../terminal-dock-host.tsx` keeps ordinary running/degraded behavior. Fleet-wide reconnecting may reflect another workspace's failure: allow local terminal creation only when native startup is ready, the enabled agent is running/degraded and desired running, and the active workspace is present in the native runtime snapshot. Keep local-machine and session-readiness checks. This UI evidence grants no authority; backend session authorization and resource ownership remain unchanged.
