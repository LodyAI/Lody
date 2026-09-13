# Replace source-stream grants with static publications

Status: proposed
Translation: pending

## Abstract

Live sharing ties recipients to the source document and makes workspace encryption
depend on a server being able to read that document. The replacement protocol uses
client-captured history JSON and copied attachments, with immutable deployment
objects and an atomic publication pointer. The publisher remains accountable through
workspace membership, while the reader receives no workspace capability. The cutover
is not released. The anonymous JSON reader and human-confirmed MCP publication
are wired; service acceptance is owned by the hosting composition.

## Responsibilities and alternatives

The client hydrates and freezes readable history, discovers typed attachment
references, and prepares checksummed objects. The host authenticates publication;
the anonymous client reads only the selected deployment. Settings owns paginated
inventory and reuses the same copy/reset/revoke actions as conversation management.

Exporting a full Loro snapshot would also expose document roots and historical
operations outside the intended transcript, and tie archived shares to future
document migrations. Rebuilding a clean Loro document would avoid some disclosure
but retain that dependency. A thin JSON manifest plus the existing stored-history
format removes it without inventing another message representation. This deliberately
preserves tool and thinking fields; no claim of automatic secret removal is made.

The temporary `SESSION_SHARE_FILE_ATTACHMENTS_ENABLED` product switch is off.
Capture replaces typed file blocks (including input blocks) with localized plain
text before reading attachments; images still copy normally. The upload client
and hosting publication authorization reject inventories containing files. The
capture option alone is not an entitlement. This does not redact opaque tool
payloads, change existing publications, or implement billing; reopening requires
shipping the switch change to client and host, then redeploying omitted files.

Conversation identity must outlive deployment retention. Reusing a removed child's
ID for another child makes an existing deep link silently display different content.
Persistent bounded identity assignments prevent this; garbage collection must not
erase those assignments. Idempotent begin requests must bind initial credentials
and confirmation identity as well as object hashes, or a retry can report success
for a different link credential.

MCP responses echo the caller's `requestId` retry key and separately expose the
server's `shareRequestId`; the document ID is never substituted for the retry key.
Upload credentials live only in the open editor. After it closes, unfinished
requests must be abandoned and recreated with a new key; ordinary draft shares
must be revoked before preparing another copy. The UI describes this explicitly
rather than promising resumable uploads or persisting another secret.

## Outcome and verification limits

The reader resolves one deployment and independently cancels main/side history
loads; late results cannot replace another conversation. The original tree leading
slot and Markdown omission notice are pure shared presentation components. Ordinary
Markdown and ACP image URI rendering was a second source-read path, outside typed
attachment callbacks; the reader now suppresses those loads, and its host must
independently restrict image origins. Inline bytes remain displayable. This does
not authorize arbitrary URI fetching during publication: typed resources are
copied; unsupported embedded links are counted and disclosed before confirmation.

The format/export tests exercise detached capture, closed object inventories,
attachment remapping and relationship validation. They do not establish hosted
authorization or a complete publishing/reading workflow. The new Settings surface
is wired into desktop and route-based settings. Production-reader browser checks
cover the tree/Tab/side layout and static protocol; native-device acceptance is
separate. No release or migration is asserted by this note.

The [current draft](../../../../specs/session-sharing.md) replaces the live-reader
intent in the [earlier sharing record](../../implemented/feature/2026-09-09-session-sharing.md).
That record remains historical, not authority for the new protocol.
