# Codex plan command

Status: draft
Translation: current

[中文](codex-plan-command.zh.md)

When a user sends `/plan <request>`, Lody enables Codex plan mode and submits the request in that mode. Already-enabled planning stays enabled. Text, subsequent content blocks, and attachments are preserved; the command prefix is not model input. A standalone `/plan` retains its mode-toggle behavior and starts no model turn.

The Codex adapter owns command parsing and mode changes. It advertises optional prompt input. Configuration must succeed before submitting content, without changing approval or sandbox settings. Requests with content follow normal insertion acknowledgement, cancellation, and terminal failure behavior in both ACP versions; ACP v2 must not acknowledge them as local commands.

## Evidence

- [Command handling](../packages/acp-extension-codex/src/CodexCommands.ts)
- [Configuration tests](../packages/acp-extension-codex/src/__tests__/CodexACPAgent/session-config-options.test.ts)
- [ACP v2 lifecycle tests](../packages/acp-extension-codex/src/__tests__/CodexACPAgent/prompt-v2.test.ts)
