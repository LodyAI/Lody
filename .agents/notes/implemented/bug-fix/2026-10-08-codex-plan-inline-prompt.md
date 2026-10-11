# Preserve requests after Codex /plan

Status: implemented
Translation: current
PR: https://github.com/LodyAI/acp-extension-codex/pull/65

[中文](2026-10-08-codex-plan-inline-prompt.zh.md)

## Abstract

The Codex adapter rejected every argument after `/plan` and classified every invocation as a local command. It now enables planning before passing text and attachments to the existing prompt pipeline. Standalone mode toggling is preserved. ACP v2 requests with content wait for native insertion instead of acknowledging prematurely.

## Decision and validation

Reuse `CommandHandleResult.prompt`, rather than starting a second command-specific turn. Both classification and dispatch use the same content extraction, including separate text blocks and image-only requests. A failed mode change stops submission. The command catalog declares optional input; approval and sandbox configuration retain their existing owner.

Behavioral coverage extends the existing configuration and ACP v2 suites for both initial modes, multiline text, attachments, insertion timing, and configuration failure. See the [draft contract](../../../../specs/codex-plan-command.md). Type checking and bundling passed. A real Codex run of a synthetic inline planning request completed with one model turn and plan deltas. The adapter suite and targeted reruns cover the change; repository documentation checking remains blocked by links into other uninitialized submodules. This source change does not publish or replace an installed runtime.
