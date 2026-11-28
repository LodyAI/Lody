# Recover and cache native mobile Agent Role listings in composers

Status: implemented
Translation: current

[中文](2026-11-28-mobile-role-selector-recovery.zh.md)

## Abstract

Opening the run-config sheet on native mobile new-chat and conversation composers intermittently omitted the Role row while still showing Agent and Model options, because `options` restored immediately from local storage and retried on runtime readiness, whereas `roles` ran once on mount, had no local display cache, and left `roles` permanently `nil`/`null` for the page lifetime whenever the initial `agentRoles` call hit a starting WebView or a transient `meta` catch-up yield. Both iOS and Android now restore plaintext-scoped cached Role listings for display before live validation, re-read Roles on runtime readiness, catalog/option updates, and `agentRolesChanged` events without overwriting loaded rows on transient failures, and bound `agentRoles` list reads across active error-free `meta` catch-up slices in `cloud-runtime`. Cached Role rows never authorize sending or bypass send-time Role revision and target checks; live multi-device cloud bursts remain covered through deterministic host and unit harnesses rather than physical-device cloud load.

## Decision

- **Align Role lifecycle with creation options on iOS and Android (`CreateSessionController.swift`, `CreateSessionHostController.swift`, `SessionComposerModel.swift`, `CreateSessionRepository.kt`, `CreateSessionScreen.kt`, `ChatScreen.kt`)**:
  - *Trigger*: Entering New Chat, a conversation, or a draft Tab while the WebView runtime is still `starting`, reconnecting from background, or catching up workspace streams.
  - *Spread*: Previously a single failed `agentRoles` read left `roles == nil`/`null` for the lifetime of the screen while `options` recovered automatically via `live` / `READY` events, hiding only the Role row inside an otherwise populated run-config sheet.
  - *Recovery and dependencies*: Unloaded Role lists retry automatically on runtime `live` / `RuntimePhase.READY`, `creationOptionsChanged` / `Synced`, `agentRolesChanged`, and manual retry actions (debounced 150 ms with no background polling timer), owned by the screen/composer task and cancelled on view/scope teardown.
  - *Results and hazard*: Transient refresh errors retain any cached or previously loaded Role list instead of resetting to `nil`/`null`. Role loading never gates `canSend`, so workspace-stream failures cannot block ordinary non-Role conversations, and send-time execution still re-reads the authoritative Role row and revision in `cloud-runtime`.
- **Add plaintext-scoped local display cache for readable Roles (`CreateSessionService.swift`, `AtomicCatalogStore.kt`)**:
  - Restore the last readable Role list per account and workspace (`creation-roles:v1:` in iOS `LocalStore` fenced by logout generation; `roles-` in Android `AtomicCatalogStore` bounded to 16 snapshots and pruned on account/logout changes) alongside `cachedOptions`, gated by plaintext workspace admission so encrypted workspaces never persist plaintext Role rows.
  - Prioritize workspace-wide `chat` options and `roles` ahead of the 10 per-project `options` reads in `NativeShareCoordinator.swift` so backgrounding mid-prefetch does not leave the iOS Share Extension with cached models but no `roles.json`.
- **Wait up to 3 seconds on active error-free `meta` catch-up for `agentRoles` list (`handlers/settings.ts`)**:
  - Extend the bounded `catchingUp.get('meta')` wait from [mobile mention catch-up readiness](2026-11-26-mobile-mention-catchup-readiness.md) to read-only `agentRoles` (`action === 'list'`) so routine `>= 12 ms` `meta` import-slice yields do not reject with `workspace_changed`.
  - *Base behavior and hazard*: Offline or failed `meta` streams clear `catchingUp` immediately and still reject `replicaScope` without waiting; Role writes (`save` / `delete`) retain immediate scope checks.

### Rejected alternatives

- **Block `canSend` or hide the run-config sheet until `agentRoles` succeeds**: Rejected because a local failure on `${workspace}:wf:workspace` must not turn into a global send gate when `meta` and machine streams are healthy enough to start a normal conversation.
- **Return an empty `[]` Role list when `DataRuntime` is not ready**: Rejected because `[]` is indistinguishable from a workspace with zero Roles, causing `ShareStore` and display caches to overwrite real Role catalogs with empty lists.

## Verification

- Shared runtime: `apps/mobile/ios/apps/ios/tests/native/agent-roles.test.mjs` and mirrored `apps/mobile/android/runtime` snapshot/asset suite.
- iOS unit and native verification: `apps/mobile/ios/packages/LodyKit/Tests/LodyKitTests/SessionComposerModelTests.swift` and `apps/mobile/ios/apps/ios/verification/kit/{create-session,session-roles,share}/main.swift`.
- Android unit verification: `apps/mobile/android/app/src/test/kotlin/app/lody/android/create/CreationRefreshTest.kt` and `apps/mobile/android/app/src/test/kotlin/app/lody/android/runtime/CreationJsonTest.kt`.
- Limits: Exercised against deterministic host/JVM harnesses and synthetic runtime states rather than live physical-device network transitions.
- Pull requests: [LodyAI/lody-ios#214](https://github.com/LodyAI/lody-ios/pull/214), [LodyAI/lody-android#98](https://github.com/LodyAI/lody-android/pull/98).
