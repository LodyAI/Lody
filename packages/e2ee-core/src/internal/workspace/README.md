# Workspace consumer

`E2eeWorkspace` (exported from `@lody/e2ee-core`) is the platform-neutral
composition facade over the workflows; see [workflows](../../../docs/workflows.md#e2eeworkspace).
Product E2EE remains disabled.

Provide an explicit `WorkspacePlatform` Effect Layer. Its scoped acquisition returns
the workspace's ports (`WorkspacePorts`: Streams log and feed sync, staging/mailbox,
stores, protectors, identity), recovery configuration and model storage; the facade
builds `E2eeWorkflows` and `WorkspaceControl` from them. `create` initializes these supplied
workspace resources. The Lab creation adapter first reads back its protected initial
key, then resumes the original signed-genesis journal over authenticated HTTP;
remote creation remains an explicit platform capability.
`open` reopens retained originals and independently selected pins. The static recovery entry invokes the real vault workflow, closes its temporary R
scope, and rechecks newly admitted personal C before opening C resources. Owned
opaque recovered keys transfer into C’s protected store; all temporary copies are
disposed. Pending/Conflict return no workspace.

The facade owns common close, command serialization, finite key rounds, installed
history and content bindings. `execute` uses the existing Committed/Conflict/Pending
P09 outcome and never silently re-signs. `rotate`/`removeMember` use the supplied
staged publisher; an unconfigured publisher fails explicitly. `document` returns
seal/open/position-bound snapshot plus the platform's native document owner.

`rotationStatus()` returns `rotationRequired`, `epoch` and `mayRotate` from the
current verified view. Only an active Owner/Admin personal device has `mayRotate`;
this reports permission, not whether a publisher adapter was configured. Refresh
explicitly to observe remote changes. The query never signs or publishes. Lab's
`rotateIfRequired` refreshes, reads this signal and invokes the same publisher only
when rotation is needed and permitted; explicit manual rotation stays available.

`recovery.setup/test/status` use the explicitly configured recovery workflow.
`recovery.skip` requires explicit recovery-loss confirmation, while
`recovery.replace` resumes the same durable replacement workflow. Product callers
can reach these choices through the facade without opening a second recovery owner.
Without it setup/test fail and status reports paired/envelope/recoverable false;
that is not an installed vault. The Lab's full session consumes this same facade,
with concrete native HTTP, SQLite, Loro and Flock adapters.

`close` rejects new work, stops native admission, joins active operations, then
closes owners. It publishes no Streams EOF and deletes no journal or installed key.
Failed acquisition also closes its child scope. One cached close completion is
shared by explicit callers and parent release.

Snapshot-first invitations follow the [draft contract](../../../../../specs/e2ee/snapshot-join.md).
The imported inviter key is independent of mailbox/SQL. The snapshot is endorsed
state, not a proof of an honest endorser or current server freshness. Retained
suffixes are still verified one by one; a historical known device may read only
control bytes to learn its revocation.
