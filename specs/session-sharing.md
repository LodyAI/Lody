# Read-only live session sharing

Status: draft
Translation: pending

A conversation owner can explicitly publish a link that lets its holders read
the selected conversations and their future updates without joining a workspace.
The disclosure must explain that the complete original document and history are
readable, including fields the current view does not display. This is bearer
access, not end-to-end encryption; a recipient can forward the complete link.

## Responsibilities and access

The shared client supplies management UI and a separate read-only reader. An
optional cloud service authorizes sharing; the standalone local composition
does not expose management or start authenticated cloud requests. Deployment
origins are supplied by the host, with no hosted default in public packages.

Each root has one active link, with reset and revocation controls. The owner
selects the root and each eligible related conversation explicitly, up to 32
targets. New child conversations are never added automatically. A selected
child may also have its own independent link; revoking either link does not
revoke the other. Administrative access permits revocation, not taking over an
owner's credential or changing their selection.

The link uses `/s/<shareId>#access=v1.<secret>`, with a random 32-byte secret
encoded as lowercase hexadecimal. The fragment is read by the client and sent
to the sharing API in an Authorization header. It is not an encryption key and
does reach that API. Neither workspace credentials nor upstream stream tokens
belong in the recipient's protocol. Credentials stay out of request URLs,
telemetry, and error payloads.

Only synchronized, unencrypted source conversations are eligible. Sharing must
not silently convert a local-only or encrypted conversation into a public one.

Management updates carry separate expected scope and credential versions.
Conflicting edits require a reload. Successful creation or reset saves the
secret on the current device, scoped to user, workspace, link, and credential
version. A device without that secret must reset before copying the link;
ordinary cache clearing preserves it, while a full local reset removes it.

## Reader behavior

Link previews publicly display the main shared conversation title by default.
The management dialog states this next to the link disclosure without another
confirmation. The host may serve that title, the Lody mark and fixed explanatory
copy without the access fragment; no body, summary, workspace name or attachment
content belongs in the preview. Title updates are eventually consistent.
Preview HTML and image routes must enforce the active grant lifecycle. Reset
invalidates old image versions; because the persistent share ID stays the same,
the fragment-free page can show the current preview after reset even to a holder
of an old link. The old fragment still cannot read content. Revocation stops new
preview delivery; copies already cached by external services cannot be recalled.

The authorized manifest supplies titles and the only navigable target set.
Selecting a target opens its original Loro stream in memory, including existing
history and live updates. Transient connection failures pause updates and allow
recovery; access denial or target removal clears the affected view and stops
its reads. Navigating to an unselected target cannot expand authorization.
The reader has no workspace runtime, durable document cache, composer, editing,
comment, fork, or agent-control action.

Eligible remote images and files are readable through the sharing API, including
references inherited from another storage session when authorized by the
service. Storage references never authorize navigation to that other session.
Local-only and expired attachments remain unavailable. Sharing neither uploads
local attachments nor extends their retention.

Reset and revocation stop subsequent authorized reads. Responses already in
flight have a bounded lifetime, currently at most 120 seconds; previously
delivered content cannot be recalled. End-to-end encryption, writable sharing,
comments, fork, and configurable link expiry are outside this phase.

## Evidence and limits

[Sharing invariants](../packages/components/src/components/sharing/AGENTS.md),
[public protocol](../packages/shared/src/session-sharing.ts),
[management DTOs](../packages/cloud-api/src/session-sharing.ts), and
[reader tests](../packages/components/tests/session-share-reader.test.ts)
describe the implemented client. Service authorization and deployment acceptance
cannot be established by this public repository alone. This draft has not
received linked human approval of this revision.
