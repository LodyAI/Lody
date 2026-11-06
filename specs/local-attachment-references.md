# Direct local attachment references

Status: draft
Translation: current

[中文](local-attachment-references.zh.md)

## Abstract

Electron same-machine attachments use original paths or managed local files without automatic upload or backfill. This requires a distinct reference protocol, trusted registration, Daemon resolution, preview and version compatibility. Originals are not immutable snapshots and do not widen Agent permissions. This draft records the intended guarantees; the [attachment lifecycle](../.agents/docs/cli-lib-session-files.md) describes the implemented boundaries and current limitations.

## 1. Interface with the attachment draft PR

Reuse the input snapshot, pending manager, and readiness boundary from the draft PR. Replace eligible preparation strategies without building separate new-session and continuation send flows.

| Scenario                                             | Preparation                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Electron original file to verified local Daemon      | Validate/register original path without full reads/hashing/copying; return local reference    |
| Electron pathless File/Blob to verified local Daemon | Atomically save to a persistent local attachment directory after Send; return local reference |
| Web/mobile, or Electron to remote Daemon             | Retain existing upload and verification                                                       |

Same-machine routing requires trusted local runtime identity matching the target machine ID, not Electron detection, hostname, or project kind alone. Unknown identity waits. A known local target with missing capabilities, an offline Daemon, or failed preparation reports failure without upload fallback. Original references do not mechanically inherit upload size caps; generated content still has storage limits. Edited bytes are Blob sources, not original-path references.

## 2. Local-reference contract

### 2.1 Provenance, scope, and permissions

Electron extracts the system path while the original File remains identifiable; pathless Files use the Blob branch. A trusted product window and local control entry register the file against the workspace, session, target machine, and authorization for this submission. Synchronized documents contain a verifiable reference and necessary display metadata; absolute paths stay in the local registry.

Arbitrary synchronized `path`, `machineId`, or reference IDs cannot authorize a new file. Resolution requires a valid local registration and checks that the current input belongs to its usage scope. Copying IDs between sessions, remotely fabricating IDs, and identical paths on another machine grant no access. References must not become ambient authority for arbitrary later messages; the exact submission binding and fork authorization shape are implementation-stage decisions.

ACP receives a correctly encoded `file://` `resource_link`, never only a textual path. A user-selected file outside the working directory can be registered, but this does not widen the Agent sandbox. If unreadable to the Agent, use existing permission handling or report unavailability; copying into an allowed directory or uploading must not bypass permission.

### 2.2 Original paths are not byte snapshots

Original content may change after Send; the Agent reads content at read time. Preparation and actual dispatch check for a readable regular file. Moved/deleted files, directories, devices, and pipes fail rather than silently using cached bytes. Lody never modifies or deletes the original.

Path validation handles symlinks and parent-directory redirection: resolve the target during registration, detect redirection to an unauthorized target before use, and require reselection when it changes. Never follow a substituted link unconditionally. Ordinary content edits do not create snapshot semantics. Because ACP ultimately passes a path, bytes are not guaranteed stable between validation and the Agent's later open; the Agent sandbox remains its read boundary. This version promises neither immutable snapshots nor protection against every local filesystem race.

### 2.3 Managed files, images, and history

Generated content stays a draft until Send. Save it completely to a stable directory before returning a reference, preserving the original draft on failure. Accepted messages retain generated files for execution, retry, preview, and history. Object URLs and persistent files have separate lifetimes. Pending records, history, and authorized forks retain managed files. Cleanup removes only definitively unreferenced application-owned files; uncertainty retains them.

Local images retain visual input semantics: use an adapter-supported local image input or form ACP image content from local bytes, retaining required resource links. A filename alone is not an image input. Unsupported adapters fail explicitly instead of silently degrading or uploading. Zero upload concerns Lody's attachment upload/backfill service, not existing message synchronization or the Agent's configured model input.

Other devices show “Available only on that computer” and never try their own same-named path. Preview retains Electron's narrow file-resource capabilities; a durable reference ID is not a general file-reading URL. Local resend/fork must explicitly inherit authorized use. Cross-machine forks/migrations disclose unavailable content and resolve it before execution without implicit upload. Sharing/export cannot automatically collect this type as a cloud attachment; missing content must block the operation or be disclosed rather than claiming a complete attachment package.

### 2.4 Existing protocol coexistence

Add a distinct local-reference input representation across parsing, history normalization, rendering, queueing, dispatch, resend, and fork. Existing `transport: 'local'` retains its old pending-backfill meaning: neither globally stop its recovery nor silently migrate it. New original references and managed files must never enter the old backfill scan, including during restart recovery.

Advertise a version through [Machine protocol negotiation](../packages/shared/AGENTS.md#machine-protocol-negotiation). Missing support disables new sends. Preserving opaque history in an old reader does not establish execution safety: an old Daemon must reject the entire execution request containing a new reference rather than run the remaining text. Combinations without that compatibility guarantee must not enable local-reference sending.

## 3. Implementation scope

The requested outcome is same-machine attachment use without Lody cloud upload. The following choices define the implementation boundary.

- Apply one preparation strategy to new conversations, continuations and queued sends. Capture the original OS path before `snapshotAttachmentDrafts` slices the File; retain provenance only in local draft state. An edited or generated File must use managed bytes. Freeze the target machine with the send and recheck its trusted identity before registration and dispatch. Unknown identity keeps the message pending; known local failures never select cloud upload.
- Introduce a distinct `local_attachment` input, with an opaque reference ID, owning machine, original submission identity, media kind and display metadata. Do not overload `file.sourcePath` or `transport: 'local'`. The local registry binds account/workspace, session, turn and reference to the canonical path and source kind. Registration is idempotent for the exact submission and rejects a different source under the same key. Retry uses that binding; resend creates a new authorized binding. Fork inheritance is an explicit local operation validating the source and destination, never implicit trust in copied history.
- Store registry records and generated files in a dedicated durable local store outside the existing blob/backfill directory. Original files are never copied or reclaimed. Initially retain accepted managed files; automatic garbage collection is outside this change. Failed staging may delete only its own unpublished temporary files. A lost registry produces an unavailable reference, never an upload or arbitrary path lookup.
- Preserve image semantics through the existing ACP image input plus a local resource link. The local resolver supplies bytes only for image input and preview, not for ordinary-file preparation. Protected workspaces use an admitted host-local operation; until that path is supported, they fail explicitly instead of falling back to plaintext IPC or uploading same-machine content.
- Gate authoring on a versioned machine capability and whole-request rejection of unknown required input kinds. Implement the rejection boundary before enabling authoring. Unsupported combinations show an upgrade-required error and retain the draft. Parsing must not discard a new input and then execute the remaining text.
- Render local references as normal attachment cards with an explicit local-only status. Local preview resolves the scoped registration through the existing narrow host boundary. Other devices cannot preview them. Cross-machine resend/fork is blocked until the user replaces the local-only attachment with an explicit transferred attachment. Sharing/export either discloses omission or refuses a complete attachment export; it never reads and uploads the local source implicitly.

Remote targets and clients without native filesystem provenance retain existing transfers. This change does not make remote Agent execution offline, change model-provider input handling, or migrate old pending-backfill attachments. Exact API names and storage encoding are left to implementation; the scope and authorization checks above are not.

## 4. Acceptance

Prove original-path URI encoding; no copies or traffic through actual attachment HTTP/backfill outlets for new same-machine references; no fallback during failure/retry/restart scans; visual semantics and history retention for generated images; no authority expansion through forged/cross-turn/cross-session/cross-machine references; visible missing/redirected/unreadable/sandbox-denied files; whole-request rejection for unsupported execution; and consistent preview, resend, fork, sharing, and cleanup boundaries. Include an offline same-machine send and an unchanged remote transfer, covering both landing and continuation flows.

## 5. Evidence and status

The native route is implemented in the shared preparation, Electron local control and Daemon registry boundaries. Behavioral tests cover local send without an account token, unchanged remote transfer, scoped resolution, generated-file retention, image input, resend, fork and sharing refusal. Independent code review covered transport validation and submission inheritance. Storybook covers the local-only card; packaged offline/upgrade and adapter sandbox acceptance remain unverified. Protected workspace registration and automatic managed-file reclamation are outside the supported implementation. The [earlier split decision](../.agents/notes/implemented/architecture/2026-09-14-deferred-attachment-send.md) explains why the existing draft owner is reused.

Source entry points: `packages/components/src/lib/electron-session-file-sender.ts`, `apps/electron/src/main/ipc/services/local-projects-ipc.ts`, `apps/electron/src/preload/index.ts`, `apps/cli/src/lib/{message-handler,session-file-backfill,session-file-blob-store}.ts`, and `packages/shared/src/{message-schemas,session-input}.ts`. Original File path API: [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils).
