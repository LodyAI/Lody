# Conversation context fallback and editable pasted files

Status: implemented
Translation: pending

## Abstract

Provider-native forking cannot move every conversation to every destination. The
fork menu now offers copying a precise Markdown history prefix independently of
native fork capability. Pasting more than 5000 characters creates an editable file
draft, uploaded on send and delivered through the existing ACP Resource Link
path. This replaces the previous 1024-character visual fold that expanded back to
full text at submission; it does not guarantee bounded subsequent model reads.

## Decisions and ownership

[The draft Spec](../../../../specs/conversation-context-copy-and-text-attachments.md)
defines the boundary. Message actions share the copy callback through the existing
conversation action context; earlier turns and unsupported ACP providers do not
inherit native-fork restrictions. A pure history-range helper rejects a missing
boundary. Existing Markdown serialization and omission notices remain in use,
with explicit references for omitted attachment bytes. Streaming footers expose
copy actions while completion metadata and native fork remain completion-gated.

The composer retains pasted-text identity and editing, but emits a small file-name
reference instead of expanding full content into the prompt. The shared
`use-pasted-text-attachments` hook transfers the edited bytes at send for landing,
session, and edit/resend. Existing attachment transport owns CLI download and ACP
Resource Link delivery. Landing initially locks through the composer lifetime, then hands text-file uploads
to a client-local pending submission before navigating to the reserved session route.
That task owns progress and upload-only retry across route mounts. Session creation
still atomically accepts the first turn after upload; the pending page is never a
shared history entry. Cancellation ignores late results, and account/workspace
changes prevent acceptance. Existing-session uploads retain their mounted composer
lifetime and show the same not-sent status. Edit/resend reuses ChatComposer.

A single 5000-character threshold avoids an intermediate visual state whose text
expands at send. Higher 30000/60000 thresholds and a separate 1024-character folding
tier were considered; manual conversion in both directions retains control
without per-model token estimates. No new wire fields or backend are introduced.

Programmatic conversion, chip-label edits and removal use the mention primitive's
`onTextSplice` through the composer action handle. The shared splice removes ranges
inside replaced text and shifts surviving ranges, committing selected values with
the text. Direct controlled-value writes left stale session identities behind and
could corrupt the final prompt; clearing all ranges would lose unrelated mentions.

## Verification and limits

The pending upload tests exercise the real status surface through progress,
unmount/remount, failure/retry, cancellation and late completion. Byte progress
comes from the existing upload transport; hashing and verification have separate
labels. Local IPC reports preparation/completion rather than invented byte progress.
An upload-success result only releases acceptance once; acceptance failure does not
offer upload retry. Pending state and unsent drafts are still memory-only.


Synthetic tests cover inclusive copy range, unsupported-fork menus, exact edited
file bytes, local/cloud routing and failures, and mention offsets. Composer regressions cover conversion of a committed session
mention, editing the file, restoration/removal with another session mention after
it, and final text/file blocks plus exact file bytes. A rendered streaming message
opens the real copy menu before completion; native fork stays unavailable. Both
regressions fail on the preceding `704fe4af` source and pass with the fix. Existing
composer focus and submission feedback tests pass. The header-menu suite opens the
real submenu and verifies selected destinations, disabled pending destinations, and
copying without native fork support. The copy handler catches and reports errors;
its message-action adapter explicitly discards the Promise to honor the void event
contract. This also resolves the type-aware lint failure in
[PR #558](https://github.com/LodyAI/Lody/pull/558).

A production-profile Cloud integration build and 75 focused tests passed at
`df5aec96`; the login screen loaded, but no live provider round trip was verified.
The primary checkout's full check remains blocked by missing runtime submodules
and stale installed dependencies. Focused menu tests, component typechecking and
type-aware lint use the independent build checkout with the same edited sources.

The ordinary CLI attachment download failure still yields an unavailable-file
notice; making that later failure fatal is a separate lifecycle decision.
Renderer upload failure already prevents submission and preserves the draft.
Drafts retain their existing in-memory lifetime, so app restart can lose unsent
content. Submitted files are not mutated by the draft editor.
