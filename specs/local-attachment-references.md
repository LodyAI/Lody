# Direct local attachment references (separate follow-up PR)

Status: draft
Translation: current

[中文](local-attachment-references.zh.md)

## Abstract

A separate follow-up PR will let Electron send attachments to its local Daemon without uploading: original files retain their paths, while pathless content becomes managed local files, with neither automatic upload nor backfill. This needs a distinct reference protocol, trusted registration, Daemon resolution, preview, and version compatibility; originals are not immutable snapshots and do not widen Agent permissions. The current [attachment draft PR](session-files.md) changes preparation timing and pending submission while retaining existing transports, and does not depend on this proposal. This document preserves future design, not current implementation or acceptance requirements.

## 1. Interface with the attachment draft PR

Reuse the input snapshot, pending manager, and readiness boundary from the draft PR. Later replace eligible preparation strategies without building separate new-session and continuation send flows.

| Scenario                                             | Follow-up preparation                                                                         |
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

## 3. Separate acceptance and open decisions

The follow-up PR separately proves correct original-path URI encoding; no copies or traffic through actual attachment HTTP/backfill outlets; no fallback during failure/retry/restart scans; visual semantics and history retention for generated images; no authority expansion through forged/cross-session/cross-machine references; visible missing/redirected/unreadable/sandbox-denied files; whole-request rejection for unsupported execution; and consistent preview, resend, fork, sharing, and cleanup boundaries.

That PR settles wire/IPC fields, submission binding, inherited fork authority, version capabilities and old-Daemon rejection, local image-adapter support, and file reclamation. These decisions do not block the draft PR, which must not claim permanently upload-free local attachments prematurely.

## 4. Evidence and status

Design based on inspection of `8c429a890037c5b21855ce7ef9f59e3677c25a38`; no implementation, separate model, or device acceptance. The split is recorded in the [decision note](../.agents/notes/proposed/architecture/2026-09-14-deferred-attachment-send.md). The existing blob/backfill path is described in [CLI attachment lifecycle](../.agents/docs/cli-lib-session-files.md).

Source entry points: `packages/components/src/lib/electron-session-file-sender.ts`, `apps/electron/src/main/ipc/services/local-projects-ipc.ts`, `apps/electron/src/preload/index.ts`, `apps/cli/src/lib/{message-handler,session-file-backfill,session-file-blob-store}.ts`, and `packages/shared/src/{message-schemas,session-input}.ts`. Original File path API: [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils).
