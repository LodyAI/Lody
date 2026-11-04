# Session conversation design review story

Status: implemented
Translation: current

[中文](2026-10-27-session-conversation-design-review.zh.md)

## Abstract

The session reading story showed prose and file summaries but omitted several surfaces needed for a conversation UI redesign. Its synthetic history now combines visible thinking, tool outcomes and inline diffs, comment and visual annotation references, and Markdown examples. Companion states use the same history for active work, permission and question prompts, mobile layout, and an annotated preview. The stories use production renderers and fake data, so they do not establish live runtime or native-device behavior.

## Decision

Extend the existing [session conversation story](../../../../packages/components/src/stories/SessionConversationPage.stories.tsx) rather than creating a separate visual implementation. The reading session identifies as builtin DeepSeek because the conversation renderer exposes thought prose for that provider. File selections open the real desktop diff panel or mobile drawer against a synthetic file provider. The annotation variant renders the real managed-preview surface with an inert page and an in-memory comment store; it does not emulate a live inspector or network connection. The [story guide](../../../docs/sessions-stories.md) owns the navigation and scope of these examples.

## Verification

Component type checking and browser interaction checks cover the synthetic stories in a standalone checkout with locked dependencies. The fixture does not validate the full Session runtime, Electron integration, native mobile gestures, or an actual preview transport.
