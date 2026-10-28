# Unified ACP prompt suggestions

Status: implemented
Translation: current

PRs: [Lody #1951](https://github.com/LodyAI/Lody/pull/1951), [Core #24](https://github.com/LodyAI/acp-extension-core/pull/24), [Codex #75](https://github.com/LodyAI/acp-extension-codex/pull/75), [Claude #44](https://github.com/LodyAI/acp-extension-claude/pull/44)

[中文](2026-10-27-prompt-suggestions.zh.md)

## Abstract

Core now defines a negotiated notification for predictions of the next user prompt, and the Codex and Claude adapters forward their native events. Codex preserves its source turn and success/empty/failure result; Claude preserves suggestion text and message identity without inventing a source turn. The user accepted stale suggestions and subsequently authorized Lody synchronization and composer integration. Lody delivers the latest advisory state through an independent ephemeral channel; desktop Tab and mobile Apply copy it into an editable draft without submitting it. Codex 0.164.0 defines the prediction protocol but its request handler is unimplemented; native Codex generation is therefore not available through this runtime. Claude real-model end-to-end delivery remains unverified.

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
- The root pnpm workspace already overrides Core to `workspace:*`; local consumers use this source. Core 0.3.0 is published. Both adapters now pin `acp-extension-core` to `0.3.0`, with npm-generated lockfiles and registry integrity hashes. The root lockfile remains unchanged because its override still resolves Core to the workspace. All eight submodules were aligned to their fetched upstream main commits, including the Core 0.3.0 release; after debugging, Codex again pins main commit `304d594`; managed-runtime version pins remain unchanged.
- Suggestions use a dedicated `prompt-suggestions` ephemeral channel, separate from presence heartbeat and persisted conversation history. The publisher retains up to 256 session entries for 24 hours, with 16,384-character text and bounded identity fields. This is transport retention, not turn freshness.
- The CLI accepts only negotiated events for its active ACP session, then maps them to the stable Lody session and machine. Local connections receive coalesced latest snapshots through the existing physical writer. Optional cloud bridging uses existing authorization and excludes encrypted workspaces; local-only composition never starts cloud transport.
- Renderer local and cloud stores stay separate and resolve by target machine; unknown routes return no hint. Hook snapshots guard workspace/runtime/session/machine switches. Typing, clearing and accepting do not consume shared state. Empty or failed results clear the visible hint. See the [composer interaction contract](2026-10-27-prompt-suggestion-composer-ui.md).
- Existing native transport and writer owners remain authoritative. No broader lifecycle migration was introduced into the Promise-based integration boundary.

## Verification

Core build/typecheck and all 10 Core tests passed. Adapter tests cover absent/unknown negotiation, successful generation opt-in and explicit opt-out, native text/null/failure preservation, session ownership and native-to-ACP identity, post-prompt delivery, and a rejected late Claude notification while another prompt continues. Codex covers both ACP versions. Final offline suites: Claude 1,172 passed / 11 skipped; Codex 98 passed. Both adapter builds, Codex typecheck, and changed Claude files lint/format checks passed using Node 24.22.1.

Core 0.3.0 was also checked in clean standalone adapter clones using `npm ci`: Codex typecheck, build and 11 targeted tests passed; Claude build, check and 699 targeted tests passed (10 skipped). Real-model generation and suppression remain unverified.

Lody verification after merging main: 46 CLI tests, 21 shared boundary tests, and 80 renderer/composer tests passed; the expanded six-case suggestion suite also passed with sheet acceptance and disabled focus preservation. The shared full suite previously passed 1,688 tests. Shared, CLI and components typechecks passed before the main merge. After merging main, components typecheck is blocked by the installed Streams dependency missing main's `onSnapshotRecovery` patch; the E2EE consumer is unchanged from main. Root formatting and documentation checks passed. Root `pnpm check` is blocked during Devin adapter preparation because that checkout lacks dependencies; this is not a passing full-workspace check. Root lint also encounters missing Node/React/Vite type definitions in other checkout scopes. Storybook browser checks cover desktop Tab, mobile Apply, hiding while typing and restoration after clearing without console errors. These use synthetic component data, not a live model or full application session.

## Codex runtime availability correction

The presence of the prediction schema does not establish that the shipped runtime produces predictions. The exact `rust-v0.164.0` source routes `thread/prediction/request` directly to method-not-found with “thread/prediction/request is not implemented yet”; searching that source finds the notification definition but no producer. An isolated probe against Lody's installed Codex 0.164.0, after `initialize` with `experimentalApi: true`, returned error `-32601` with that message. The probe used synthetic thread/turn IDs, a temporary Codex home and no model turn; no user conversation or credentials were copied.

Local diagnostic logs show negotiated v1 and normal prompt completion, but no native prediction receipt. The running packaged adapter was checked to contain the diagnostic code. This explains why the forwarding tests pass while the composer receives no suggestion. Negotiation advertises the adapter's ability to forward this contract, not proof of native generation. Do not infer an empty prediction or model suppression from this silence, and do not add a guessed feature flag or automatically invoke the unimplemented request. Native support needs to be verified before selecting a newer runtime; an independent prediction model call would be a separate product/cost decision.

Evidence: [0.164.0 request dispatch](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/message_processor.rs#L1482), [protocol types](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs).

## Evidence

- [Core contract and negotiation](../../../../packages/acp-extension-core/README.md#prompt-suggestions).
- [Codex event schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionUpdatedNotification.ts), [result schema](../../../../packages/acp-extension-codex/src/app-server/v2/ThreadPredictionResult.ts) and [mapping](../../../../packages/acp-extension-codex/src/CodexEventHandler.ts).
- [Claude mapping and native options](../../../../packages/acp-extension-claude/src/acp-agent.ts), pinned SDK 0.3.293: suggestions are emitted after result and can be suppressed by settings, plan mode, first turn, errors and quota.

Assistant chunks were rejected because they pollute conversation history; requiring a source turn was rejected because Claude does not provide it. Empty/failure collapsing would lose Codex semantics. The user chose permissive advisory delivery over a separate investigation of Claude cross-turn correlation.
