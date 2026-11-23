# Session automation identity

Parent rules apply. `CLAUDE.md` links here; edit `AGENTS.md` only.

`session-meta-identity` reads only the current runtime-scoped repo cache after the
target session projection has drained. Pending-send overlays and menu catalog
matching cannot supply it. IDs come from that actual row and scope; route inputs
only select which record to observe. Hidden sessions render no marker.

These IDs name an expected target. Independent observers still prove execution;
the marker supplies neither persistence nor remote acknowledgement. Do not add
queries, writes, refreshes, credentials or user content to this projection.

## Control and readiness markers

- Key workspace, machine, invitation, membership and composer controls expose
  stable `data-testid` values independent of translated labels. Repeated rows keep
  the existing full identity attribute (`data-settings-machine-id`,
  `data-machine-id`, `data-membership-id`, `data-request-id`, `data-device-key`,
  `data-agent-config-id`).
  These are public identifiers, never invitation tokens, credentials or key bytes.
- `workspace-ready` exists only while the sidebar's scoped workspace data is ready;
  it is not execution permission. Tests must still bind the workspace and observe
  the required content or control surface. Preserve existing semantic/identity
  attributes so older harnesses continue to work.
