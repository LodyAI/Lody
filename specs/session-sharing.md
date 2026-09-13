# Static conversation sharing

Status: draft
Translation: current

[中文](session-sharing.zh.md)

A workspace writer publishes a selected conversation and related conversations
as an independent readable copy. Later source edits do not change that copy.
"Update deployment" captures a new copy and atomically replaces the current
deployment without changing the complete share link. A failed or competing
deployment must leave the current copy intact.

## Publication boundary

The readable client hydrates all selected conversations, then synchronously
detaches their stored history before attachment I/O. It preserves the existing
history JSON, including thinking, tool inputs/outputs, system entries and unknown
fields. It does not export Loro operation history or the surrounding document's
runtime configuration, queued messages, agent sessions or workspace credentials.
History itself can contain sensitive text: publication is disclosure, not
automatic sanitization.

Task-proposal notices are the exception: capture removes their complete display
blocks and metadata before attachment reads, and readers reject unfiltered proposals.
Subagent execution records and opaque tool/text content remain unchanged.

A versioned manifest describes conversations, their relationships, immutable
history objects and copied attachments. The rollout switch
`SESSION_SHARE_FILE_ATTACHMENTS_ENABLED` defaults to false: typed `file` blocks
are replaced with a localized ordinary text notice before any attachment reads;
only typed images/image groups are copied. File names, source IDs and paths from
those blocks are omitted too. Publication rejects file inventories independently
of the client. This is not a sanitizer for opaque tool payloads or text, and does
not alter already published versions. Reopening requires a new deployment to add
previously omitted files; future paid entitlements are outside this change.
Every object has an exact ID, byte length
and SHA-256 checksum. Sharing never authorizes access to a source workspace,
inherited attachment namespace, original Stream or agent runtime. Unavailable
attachments must block capture or be explicitly disclosed as unavailable; they
must never silently fall back to source access.

Workspace Stream encryption is a separate future feature. The publishing client
will decrypt before preparing the same plaintext sharing package. The share
bearer is an access credential, not a decryption key. No sharing E2EE format,
encryption envelope, or key escrow is part of this version.

## Permissions and management

A workspace writer may publish content they can read, under their authenticated
publisher identity. A publisher can update, reset or revoke their own share.
Administrators and owners can inspect the workspace's share inventory and revoke
others' shares, but cannot obtain others' link secrets or take over publication.
Source metadata is not an author-identity certificate.

Settings → Share management lists successfully published shares, not unfinished
uploads. Ordinary members see their own shares; administrators see the workspace
inventory. The list is paginated and shows title, status, conversation count and
last update. Source removal does not remove the published copy or its management
entry. Updating requires the sources to remain readable; reset and revoke do not.

Shares remain readable after source deletion. Removing the publisher's membership
or deleting their account or workspace disables access. A replacement membership
does not revive an old share. Reset does not rebind ownership or membership.

The link is `/s/<shareId>#access=v1.<secret>`, using a random 32-byte bearer.
Only its hash belongs in the control plane; the raw secret stays device-local and
travels to the share API only in an Authorization header. An update preserves it.
Reset rotates it; revoke disables every deployment. Neither operation can recall
bytes already downloaded.

## Deployment consistency

A client freezes the complete package before upload, and only a human action in
the authenticated app starts that publication. There is no publication preview:
confirmation approves the selected scope and disclosure, then freezes and uploads. Upload authority is limited to one immutable inventory and
cannot publish. Only the authenticated app commits
a sealed deployment. Publication uses the expected share revision; begin retries
bind the complete request identity, including credentials and confirmation
request, rather than silently accepting changed parameters.

For a new link, the client durably saves and verifies the reader credential using
the begin response's share ID/version before upload and again before committing.
Storage failure stops publication and preserves the same deployment for retry.
Closing during the final commit cannot discard the credential; reopening resolves
server status and reconstructs the link. Upload secrets are not persisted.

Readers resolve the current deployment once, then pin all history and attachments
to that deployment. A retired deployment has a bounded grace interval; no read
mixes object versions. Reset and revoke override that grace interval.
Conversation identity assignments survive removal and old-object collection:
an old child link must never open a different conversation.

Private object storage has no public bucket URLs. Every object read is authorized.
HTTP responses are no-store and have a bounded lifetime. Old deployments and
abandoned uploads require quota-accounted, fenced garbage collection.

## Reader and agent interactions

The share page preserves the application's layout for what a reader needs:
independent child conversations appear in the left conversation tree and child
Tabs in the main tab bar. It has no right pane, so a side-panel child appears in
that same tab bar rather than being hidden; published content is never
unreachable. Relationships come from the manifest, not hidden references in
history. Navigation never expands the manifest.

Markdown is generated only when requested, using the existing conversation-copy
builder, range selection, budget rules and result notices. It is a readable
export, not a lossless serialization of every stored tool field. It does not
include original workspace or agent identities in added export metadata.

MCP may request publication but may not approve it. A pending card in the
authenticated app requires human confirmation before the client prepares and
publishes the copy. A tool-return flag or history text is not approval.
The tool echoes the caller's `requestId` for retries and returns `shareRequestId`
separately as the server record identity. Closing the editor discards upload
credentials: an unpublished request must then be abandoned and recreated with a
new retry key; an ordinary draft must be revoked before preparing another copy.

Fork is out of scope for version one. A future fork may import displayable history
and attachments into the visitor's workspace; a new agent receives Markdown in a
new context, never a restored source agent thread or runtime session.

The reader instead offers **Copy Agent Prompt** beside Markdown copy. A deliberate
click obtains a short-lived read-only link pinned to the displayed deployment and
selected conversation; the prompt follows the reader's current i18n language. Its index
lists the existing conversation relations, history URLs and image URLs. Recipients
need HTTP access, not a Lody account or MCP. No workspace import or agent dispatch
occurs. Recipients can save downloaded content; the visible disclosure must say
that the prompt grants access to the shared conversations and images.

Agent access expires within 24 hours and cannot outlive the version's readable
lifetime or share revocation/reset. It cannot renew itself, publish, upload or read
source resources. Files remain excluded from the agent resource API. Hosting must
rate-limit issuance and reads by IP and share, omit capability URLs from logs, and
keep responses private/no-store. This is burst protection, not a billing quota.
Clipboard denial exposes the generated prompt for manual copying; access links
are issued only from published deployments.

## Implementation status and evidence

This is an in-progress breaking cutover, not a released or fully verified feature.
The portable package/export/client and management surfaces are implemented locally.
The anonymous reader now pins a deployment, reads JSON without a Loro subscription,
and presents the opened-by tree, child Tabs and side conversations. Markdown uses
the existing copy builder on demand; the app and reader share omission notices.
Raw remote images do not load in the reader. Typed attachments use the manifest;
unmapped resource references are inert rather than source download authority.
MCP confirmation is wired through a nullable cloud port: the CLI submits intent,
the app displays canonical requests, and final confirmation locks the selected
set. Confirmed unfinished deployments remain visible and can be abandoned.
Typed resources are copied; arbitrary Markdown/ACP resource URIs remain text and
are disclosed before confirmation, never fetched with workspace authority.
Reader production-build browser checks cover layout, pinned deployments,
credential changes, revocation and inert media. Service integration is validated
separately; no hosted deployment or native-device acceptance is asserted here.

[Package](../packages/shared/src/session-share-package.ts),
[exporter](../packages/shared/src/session-share-export.ts),
[management DTOs](../packages/cloud-api/src/session-sharing.ts),
[Settings surface](../packages/components/src/components/settings/share-management-setting.tsx).
Service authorization and deployment acceptance cannot be established by this
public repository alone. This revision has no linked human spec approval.
