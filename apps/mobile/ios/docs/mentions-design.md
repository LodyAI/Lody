# Mentions alignment (#11)

The picker inserts references, never instructions. Files stay `@path`, skills
use `$name`, GitHub references stay `#number`, commands stay `/name`. Session
and Role references carry an explicit namespace and stable id (`@session:id`,
`@role:id`) so a restored native text draft cannot silently bind to a renamed
session, another Role, or a file with the same name. Labels in the picker remain
human readable. This deliberately retains the namespaced spelling rather than
introducing a second persisted range/chip model in the native composer.

The runtime expands immediately before `sendTurn` writes history or the queue.
Creation's first turn uses that same send operation; Steer moves an already
expanded queue entry without expanding it twice. File, issue, PR and command
expansion is identity. Skills resolve their machine path; sessions become the
OSS MCP history query; Roles become the OSS MCP create-session instruction.
Role mentions do not mutate the current turn's `agentRoleId` or run config.
This is independent of #19's current-session Role selector; both must consume
the workspace Role catalog, with private-role visibility and machine binding
checked before expansion. No separate Role store or CRUD is introduced here.

Catalogs remain native-runtime owned. Session candidates use workspace metadata,
exclude the current session and rank unarchived entries first. Commands come from
the selected agent's machine capability. Optional catalogs with no usable rows
are hidden. File traversal and its 20,000-file ceiling remain unchanged, and
partial/truncated results stay visible in the picker. Expansion failures happen
before any durable write and leave the draft available to retry. Partial skill
discovery also blocks expansion: otherwise a missing project override could
silently resolve the same token to a global skill.

GitHub categories require a GitHub project (`github:owner/repo`). Native code
exchanges the Keychain login session for a short-lived Convex JWT, then calls
the official client repository-token action. Login sessions are not CLI tokens.
All three credentials stay native; only open issue/PR display rows reach RN.

Verification covers reference insertion in both production hosts, direct `$` and
`/`, cancellation, missing optional sources, truncation, and the actual outbound
prompt for normal sends, queued sends, first turns and Steer. Offline fixtures
exercise production components without user credentials or a connected machine.
