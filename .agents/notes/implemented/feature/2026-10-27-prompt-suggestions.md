# Unified ACP prompt suggestions

Status: implemented
Translation: current

PRs: [Core #24](https://github.com/LodyAI/acp-extension-core/pull/24), [Codex #75](https://github.com/LodyAI/acp-extension-codex/pull/75), [Claude #44](https://github.com/LodyAI/acp-extension-claude/pull/44)

[中文](2026-10-27-prompt-suggestions.zh.md)

## Abstract

Core now defines a negotiated notification for predictions of the next user prompt, and the Codex and Claude adapters forward their native events. Codex preserves its source turn and success/empty/failure result; Claude preserves suggestion text and message identity without inventing a source turn. The user explicitly accepted stale suggestions and limited this implementation to Core and adapters. Workspace integration is implemented; standalone publication, Lody synchronization and composer UI remain separate work.

## Contract and mapping

Both peers advertise `promptSuggestions: { version: 1 }` under their capability object's `_meta.lody`. The `_lody/session/prompt_suggestion` notification carries:

```ts
type LodyPromptSuggestion = {
  sessionId: string;
  sourceTurnId?: string;
  suggestionId?: string;
  result:
    | { type: 'completed'; text: string | null }
    | { type: 'failed' };
};
```

Core exports the method map, type, negotiation helper and boundary guard. Unknown capability versions do not opt in. Preserve exact text, including empty strings. Null means completed without a suggestion; failure concerns prediction only, not the conversational turn.

Codex maps the owning `threadId` to ACP `sessionId`, preserving native `sourceTurnId` and `result`. Its existing session notification path delivers after prompt disposal, for both ACP v1 and v2. Foreign/child thread predictions do not become root suggestions. The adapter does not request generation or override native prediction settings.

Claude negotiation enables SDK `promptSuggestions` unless provider options explicitly disable it. Without negotiation, existing provider options are untouched and no Core suggestions are emitted. The existing long-lived consumer maps `uuid` to `suggestionId` and `suggestion` to completed text. It validates the query's native session identity and maps recreated native sessions to their stable ACP owner. Failed suggestion delivery is logged without terminating the query or failing a later prompt. No retry queue, timeout, turn ID inference or freshness filter was added.

## Decisions and limits

- The user accepted potentially stale suggestions. `sourceTurnId` stays absent for Claude; no `validForTurnId` or synthetic turn binding is introduced. A message UUID is not a source turn.
- Notifications are advisory, can follow prompt completion or newer input, and never enter assistant text or automatically become user input. No history/read/retry API or per-turn delivery guarantee is implied. SDK suppression is not a failure.
- The root pnpm workspace already overrides Core to `workspace:*`; local consumers use this source. Core 0.3.0 is published. Both adapters now pin `acp-extension-core` to `0.3.0`, with npm-generated lockfiles and registry integrity hashes. The root lockfile remains unchanged because its override still resolves Core to the workspace. The integration PR pins the reviewed source commits; package versions, runtime pins and publication remain unchanged.
- The proposed product direction remains a composer hint accepted by Tab into an editable draft, without auto-submit. Independent ephemeral latest-state synchronization is appropriate; the existing `presence` heartbeat channel must not carry suggestion text. This UI/synchronization direction was not implemented or tested.

## Verification

Core build/typecheck and all 10 Core tests passed. Adapter tests cover absent/unknown negotiation, successful generation opt-in and explicit opt-out, native text/null/failure preservation, session ownership and native-to-ACP identity, post-prompt delivery, and a rejected late Claude notification while another prompt continues. Codex covers both ACP versions. Final offline suites: Claude 1,172 passed / 11 skipped; Codex 98 passed. Both adapter builds, Codex typecheck, and changed Claude files lint/format checks passed using Node 24.22.1.

Two Claude initialization snapshots were updated only for the new capability. The broader suite exposed nine existing v2 task actor snapshots; `bash-background` reproduces with the unchanged adapter source. Full default adapter test runs were stopped after existing real-runtime cases attempted network access and Codex authentication failed. Real-model generation and suppression remain unverified. PR preparation also attempted root `pnpm check`/`pnpm format` and Claude `npm run check`; missing workspace dependencies and now-unavailable dependency symlinks prevented those reruns. The successful targeted checks above preceded that environment change. Root documentation checks retain existing missing-submodule link failures; no new note-link errors were introduced (40 baseline errors remain).

The Core 0.3.0 dependency update was verified in clean standalone clones using `npm ci` against the published package: Codex typecheck (including examples), build and 11 targeted tests passed; Claude build, full `npm run check` and 699 targeted tests passed (10 skipped). Root checks remain blocked by missing workspace dependencies.

## Evidence

- [Core contract and negotiation](../../../../packages/acp-extension-core/README.md#prompt-suggestions).
- [Codex event schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionUpdatedNotification.ts), [result schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionResult.ts) and [mapping](../../../../packages/acp-extension-codex/src/CodexEventHandler.ts).
- [Claude mapping and native options](../../../../packages/acp-extension-claude/src/acp-agent.ts), pinned SDK 0.3.293: suggestions are emitted after result and can be suppressed by settings, plan mode, first turn, errors and quota.

Assistant chunks were rejected because they pollute conversation history; requiring a source turn was rejected because Claude does not provide it. Empty/failure collapsing would lose Codex semantics. The user chose permissive advisory delivery over a separate investigation of Claude cross-turn correlation.
