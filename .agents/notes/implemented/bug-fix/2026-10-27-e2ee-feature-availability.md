# Explain unavailable encrypted-workspace features

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1967

[中文](2026-10-27-e2ee-feature-availability.zh.md)

## Abstract

Encrypted workspaces deliberately reject unprotected side channels, but several UI
entries disappeared without explanation, waited forever or surfaced internal codes.
The UI now uses the existing capability verdict with one localized reason per feature.
Unsupported actions are disabled or replaced by an explanation before editing or
transfer; operation guards remain and refused attachments retain the draft. This
availability fix does not implement encrypted RPC, presence, attachments, schedules,
sharing, exports or Code Collab indexes.

## Decision and boundaries

- Reuse `workspaceSupports` and `useWorkspaceFeature`, rather than adding another
  capability matrix. `workspace-feature.ts` owns localized reasons and a recognizable
  guard error. Display checks the admitted workspace mode; operations check their own
  runtime/content even if callbacks or deep links bypass the UI.
- Composer menus show disabled actions with visible explanations on desktop and touch.
  Conversation menus explain exports, sharing, remote preview and RPC. Remote machine
  detail/provider controls and schedule deep links show a notice before mounting the
  unsupported editor. Remote goal, edit-and-resend and native steering affordances
  respect RPC availability; durable send and cancel keep their existing paths.
- Presence uses the existing status slot below browser-offline and machine-removed,
  with neutral copy instead of claiming the machine is offline. Code Collab terminates
  its disabled-index loading state with an unavailable reason. Confirmed same-machine
  desktop file preview keeps its provider and IPC operation; the index remains off.
- Attachment admission rejects before callbacks, stores or the pending-send queue
  consume a draft. Prompt, reserved session ID, source bytes and image preview survive
  navigation. Prepared local file receipts remain admissible. A failed local handoff
  cannot fall back to an unprotected upload.
- Ordinary capability verdicts and transport branches are unchanged. These synchronous
  guards do not change resource ownership or justify a lifecycle migration. Existing
  [M2 restrictions](../../proposed/architecture/2026-10-22-e2ee-m2-product-integration.md#unencrypted-exits)
  remain in force.

## Evidence and limits

Deterministic tests exercise rendered disabled menus, English/Chinese presence copy,
schedule reasons/deep links, remote form suppression, Code Collab unavailability and
local preview, real persistent draft hooks and prepared local files crossing real
Loro history writes. With the implementation withdrawn to main, nine selected
regressions fail on their intended assertions and exit normally; restoring it passes.
Existing ordinary menus, attachments, machine detail and runtime suites are covered
by scoped verification.

Storybook provides encrypted desktop/mobile attachment menus, presence and feature
notices. Component tests and story rendering do not establish packaged Electron,
mobile-device or deployed encrypted-workspace acceptance. Full repository checks
remain CI work. No plaintext upload or network channel is introduced.
