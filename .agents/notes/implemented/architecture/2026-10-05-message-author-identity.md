# Message authors for Agent delegation

Status: implemented
Translation: current

[中文](2026-10-05-message-author-identity.zh.md)

## Abstract

Delegated Agent messages previously used the authorizing human's avatar. History now stores a separate versioned author snapshot while retaining human authorization and recipient execution configuration. Role-backed messages show the frozen Role emoji/name; other Agents show their Agent identity, with source model details available separately. Snapshots survive queue promotion, operation recovery and catalog deletion without live catalog reads during rendering. This adds bounded metadata storage; packaged-provider behavior and rendering performance have not been benchmarked.

## Decision and responsibilities

The [draft Spec](../../../../specs/message-author-identity.md) separates message role, human principal, author and recipient input configuration. An Agent-authored input remains a user-role message. `userId` continues to authorize execution and is never replaced by a Role id. Human edit/resend records the actual editor as the new human author.

The shared author union supports human, Agent and system variants. Agent snapshots allowlist source session/turn, Agent configuration/display identity, Role id/revision/name/emoji and model/reasoning/Fast/Plan summaries. They exclude environment, credentials and arbitrary launch configuration. Configured models are labeled separately from runtime-reported models; unavailable information remains absent.

MCP captures the exact active source turn after request validation and before operation acceptance. Callers cannot supply author fields in tool arguments. Accepted operations persist the snapshot atomically and recovery reuses it. Target Role snapshots travel with their own frozen input configurations, including queue promotion. Assistant turns capture their own identity once and reopening retains the existing snapshot. System completion envelopes remain system-authored.

The local operation database uses a separate `operation_authors` extension table with cascading deletion. Adding columns to legacy `SELECT *` operation rows or fields to strict frozen-config readers would break mixed-version decoding. The extension stores both source authors and target Role snapshots without altering those formats.

The UI uses a shared snapshot-only presentation component. Role emoji/name takes priority, including solo workspaces. Its popover shows the source Agent/model summary and source conversation link. Following user feedback, assistant replies omit the author identity entry and its popover; the avatar-free full-width body and existing configuration controls remain. Stored assistant author snapshots still support delegation provenance. Legacy history without author metadata keeps existing rendering; no guessing or history rewrite is performed.

## Alternatives and trade-offs

A UI-only lookup cannot recover historical identity after catalog edits or describe multiple source Agents chatting into one target. Replacing `userId` breaks authorization; copying source configuration into recipient input changes execution. Small frozen snapshots intentionally duplicate presentation data to preserve history. Capture adds bounded local reads at operation/turn boundaries and operation decoding reads the extension table; it adds no per-token catalog lookup or network request. These are architectural properties, not measured latency claims.

This extends [human sender presentation](../feature/2026-09-08-chat-sender-identity.md) and [local orchestration](2026-09-29-local-session-orchestration.md). Binding boundaries are recorded in shared, MCP, orchestration and chat UI scoped rules.

## Verification and limits

Regression correction after user testing: the chat-stream projection omitted `author`, so real rows fell back to human identity even though storage and isolated row tests passed. The projection now carries author metadata and invalidates cached rows when it changes. The UI regression test now feeds persisted history through ConversationView and buildChatStreamItems before rendering; the projection test covers both user/assistant authors and late metadata replacement. Both tests failed before the fix.

Behavioral coverage exercises real local MCP A→B→A attribution with distinct source/target models, target Role deletion, durable operation retry/reopen, history storage/reopen/copy, metadata validation, human edit/resend, queued Role snapshots and visible Role identity/details. The browser Storybook fixture was also inspected. Root typechecking, lint, internationalization and platform/public boundary checks pass.

The root check reaches CLI tests: 3475 pass, four skip, and the existing recursive native SSH Git credential fixture fails with `context_unreadable`; the same failure reproduces with the unchanged HEAD modules in an isolated fixture. Follow-up package tests pass, including 4765 component tests, 1272 shared tests and 199 Electron tests; docs validation reports no errors. No real-provider packaged end-to-end run or frame-time/storage benchmark was performed.

Follow-up validation: 24 projection/sender tests and component typecheck pass. Root typecheck/lint pass; the latest root test run stops at the unchanged workspace-git-service local synchronization case (3475 CLI tests pass, four skip, one fails). Docs validation passes.

Role avatar correction: the earlier empty-emoji provider fallback was inconsistent with the Role catalog, which uses getAgentRoleEmoji and a default 🪼. Both snapshot creation and presentation now use that shared contract whenever a Role exists. Provider logos apply only without a Role; unknown providers use a name initial. Legacy empty Role snapshots render the canonical default. Existing explicit emoji (including 🤖) are not rewritten. Tests compare the rendered avatar with the shared Role default and separately verify provider fallback without a Role.
