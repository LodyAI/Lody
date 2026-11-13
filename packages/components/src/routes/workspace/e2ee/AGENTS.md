# Encrypted workspace control route

Ancestor rules apply. `CLAUDE.md` is a symlink to this file.

The reader logic lives in `components/pages/e2ee-workspace-console.tsx`; these rules bind
it in both presentations. The route renders it as a page that clears the workspace
context. Settings renders it as a dialog over the open workspace: it keeps that
context, closes instead of navigating, and still owns exactly one reader. The route
imports the console relatively because the e2ee-client browser suite replaces every
`@/` import of this bundle with its injected ports.

The console owns its account/workspace reader until actual retirement. A successful
member admission or member-management operation refreshes the verified ledger through that same
reader; it must not increment the reader generation or close/reopen the host.
Management success alone does not supply the displayed role: publish only the
validated host ledger and retain its observed checkpoint. A failed validation
blocks management and preserves prior verified evidence.

Only an open console with a native or portable reader owns the optional cloud
ledger-head subscription. Treat its workspace/genesis/checkpoint as an untrusted
change hint, coalesce notifications and fetch suffixes from the reader's verified
position. Cancel the subscription on scope exit; late work cannot ingest or
publish into a replacement scope. Subscription failure preserves local evidence
and manual refresh. A live verified version replaces the team host's ledger poll;
request and key-delivery polling remain separate.

Late management results and ledger reads belong to their captured reader and
route scope. They cannot publish into a replacement account, workspace or reader.
Explicit recovery, reconnect and identity changes retain the existing retirement
and drain rules. Never relax native reader admission or authorization to make a
passive read succeed.

The cloud boundary hands the reader exactly the cloud-api history page; a hosted
backend's extra fields never reach the host's strict capture, and record validation
is never relaxed to admit them. Only an availability failure (untyped transport
errors, or a portable `network`/`closed`) leaves the verified view offline; a typed
validation, local or authorization failure shows its failure instead.

A device waiting for approval always has one way out, `E2eeLostAccessEntry`
(`components/pages/e2ee-lost-access.tsx`), beside the unchanged pairing flow. It
offers restore through the host's `RecoveryPort` first, never promising recovery
without a configured backup. It then states that the content cannot be recovered,
and only then offers the ordinary account removal from
`e2ee-workspace-removal.ts`: delete for an account owner, leave otherwise. The
listed account role only chooses which one to show; the server's ownership and
billing checks decide. Leaving or closing these steps never cancels the request or
touches keys or recovery material. A removal is reported as done only when the
server answers success or the account list no longer has the workspace; an
unanswered or unreadable result stays unknown with a retry, never failed, and a
late success still lands. Deletion says that encrypted data is erased in the
background; it never claims that erasure finished. Refreshing the list afterwards
cannot undo a confirmed removal.
