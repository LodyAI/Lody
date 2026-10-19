# Lody automatic notifications and independent channel delivery

Status: proposed
Translation: current

[简体中文](2026-10-13-agent-native-attention.zh.md)

## Abstract

Lody determines notification eligibility from trusted execution outcomes and input authors, without an agent notification tool, Inbox UI or new Web delivery. Desktop and mobile submit independently and may both alert. The implementation keeps a small shared policy and compatible adapters, with no device heartbeat, retry queue or cross-device arbitration. Current Live Activity producers are silent. Code and local tests exist; actual device display, sound and click acceptance remain outstanding.

## Source policy and minimal contracts

The [shared module](../../../../packages/shared/src/notifications/index.ts) holds source facts, AttentionItem, a shared terminal payload schema and stable provider identity. MessageHandler uses the actual policy result's recipient, source and outcome. It does not import a generic intent/router/receipt framework or create an Inbox store.

The execution owner emits succeeded, failed, cancelled or unknown from the real terminal path, freezing requester and exact input author per invocation. Human success/failure/unknown outcomes may alert; cancellation, ordinary delegated output and unknown audiences do not. RPC provenance remains unknown until the existing history writer reads that exact input, without a new pre-prompt scan.

Session containment does not determine audience. A user request contributes its exact input id as a result origin. The Host exposes those origins only in active invocation context; MCP freezes them in the existing Operation configuration. RPC/steer may start before input history sync: before accepting an Operation, MCP resolves pending provenance from the exact input or rejects retryably without creating the Operation. This does not block ordinary prompt startup. A synthetic summary inherits the complete, recipient-scoped batch membership, without pretending it has a human author. Human input carrying a batch combines its own origin with inherited origins. Successful completion requires at least one of these requests to have neither active Operations nor unconsumed results; partial summaries and further delegation retain the same origins. Failed/unknown summaries need attention immediately. Missing old provenance remains unknown. Steer uses the current requester for completion queries and cannot inherit another recipient's origins.

The sole publication boundary runs after physical execution cleanup and Inbox settlement, rechecks Stop, and freezes the fact before releasing the prompt slot. Notification delivery is tracked by the existing Host work drain, independently of visible execution and automatic Inbox launch; a slow send cannot block either successor path. Failure bookkeeping cannot skip Inbox release. Each background desktop projection holds its own document lease; phone delivery holds none. Provenance lookup failure is fail-closed for notification, never a reason to fail or replay Agent work. No scheduling predicate, database table, notification queue or polling loop is added. User-owned Goal set/resume actions explicitly retain user audience; the active provider prompt already spans internal Goal continuations. See [session relations](../../../../specs/session-relations.md) and [orchestration rules](../../../../apps/cli/src/orchestration/AGENTS.md).

Schedules currently produce ordinary user turns. Success/failure/unknown follow the same policy and cancellation is silent; high-frequency schedules may alert every run. Conditions, digests, health episodes and prehandoff alerts are deferred.

## Independent best-effort delivery

Each permitted target receives one bounded attempt. Failure, timeout, reconnection or a later lock does not retry or switch channels. Desktop activity, DND, disabled notifications or a visible source cannot suppress mobile. Two devices each alerting is accepted normal behavior, not only a rare race.

The control document stores only the latest terminal notification. Metadata carries a low-frequency 36-byte UUID activation index; the desktop reads only changed sources, with four concurrent reads and a five-second deadline. Startup/reconnection establishes a baseline instead of replaying history. Recipient, identity, freshness, current settings and current source visibility are checked before display.

Mobile remains an optional authenticated cloud capability and carries optional bounded conversation/task and project display names. These names cross the cloud/provider boundary; raw tool commands, filesystem paths and errors do not. Current protocols target permitted native subscriptions; legacy protocols retain their existing target behavior. Acceptance is not proof of device display or user reading. Local-only composition never acquires product-cloud notification capability.

The removed desktop sampler, presence heartbeats, arbitration and notification journal are not reserved as empty interfaces. There is no outbox, route epoch, claim, cross-device read protocol or dedicated notification runtime.

## Compatibility and silent activity

`terminalNotifications` capability disables idle-completion inference for new CLI peers. `LegacyElectronSessionNotifier` isolates old idle completion and current permission observation, using the same host snapshot. Remove idle fallback only when the minimum supported CLI has the capability; retire permission observation separately when typed request projections replace it.

New producers require the outcome/versioned-permission protocol. Removing capability negotiation prevents a transient probe failure from causing a lifetime downgrade or private-title fallback. Each new event attempts its own request even after an earlier transport failure; it never retries that event. Deploy the compatible backend before this CLI. Existing cloud action/port and IPC names remain transport boundaries for old callers, rather than a second internal finalization path. Desktop and mobile use one presentation catalog; legacy inputs without display context retain generic fallback copy.

The mobile summary hook never attaches permission alerts and keeps updating other work while permission is pending. Permission candidates only flush the throttled snapshot. Keep the original one-second input throttle, 250ms bridge debounce, native/settings gates, empty-summary behavior and scope teardown. The optional bridge alert field remains readable for legacy clients. Ordinary Push owns reminders independently of activity success.

## Architecture and verification limits

Ordinary types and pure functions suffice; no XState or new Effect Runtime is introduced. Existing SessionDocument/CloudPort and React bridge ownership are not a completed native Effect unit; wrapping those unfinished lifecycles would not complete a migration. Existing Effect execution/Inbox scopes retain resource, cancellation and recovery ownership; the change adds synchronous completion queries and uses the existing Promise delivery boundary. Tests exercise policy, real execution and schedule preparation, shared CRDT compatibility, mounted desktop/activity consumers and versioned transport. Regression traces cover five children returning in multiple batches, follow-up delegation, summary failure, Goal completion, full membership beyond the preview, and recipient isolation.

New global/per-source mute controls, mobile foreground-source suppression, fine-grained activity subscriptions and remote activity ordering are deferred. Source pages retain their existing errors and requests. Native display, sounds, click navigation and mixed-version device acceptance still require verification; local tests and builds do not establish delivery. The [native notification lifetime fix](../../implemented/bug-fix/2026-09-20-notification-click-lifetime.md) remains valid.

## Concise presentation

The shared presentation module uses the conversation title as the notification title
(with a localized untitled fallback). The body contains outcome, optional project,
PR number and scheduled task name, omitting the task name when it equals the title.
Conversation title and schedule name are separate bounded fields. Successful work,
including schedules, omits status copy; failures, interruptions and attention requests
retain it. When all body context is absent, an open-conversation hint keeps the
push content nonempty. Desktop registers its en/zh catalog with i18next; native
push uses the same catalog. A Schedule freezes its name on the exact user input as
`scheduleRun`, including that input id so manual edit-and-resend cannot inherit the
label accidentally. Automatic summaries use the frozen origin ids already tracked
by execution, selecting completed origins for success. Missing, mixed or more than
32 origins fall back to conversation copy. These bounded, leased reads happen after
execution release and never fetch GitHub or scan the transcript.

Display context remains optional on terminal projections and cloud DTOs; no history
backfill or new metadata index is required. It changes neither eligibility nor
provider identity. Mobile distinguishes approval/question; the existing desktop
status observer says “Attention needed” because it cannot prove the request kind.
Tests cover real history/control persistence, origin retention, mixed/manual inputs,
Unicode length bounds, bilingual payloads and unchanged destinations. Device layout
and truncation still require native verification.

Associated PRs remain visible as `lody PR #1555` in the body. The optional bounded `pullRequestNumber` crosses the desktop projection and native push context. Prefer the latest open/draft association, otherwise the latest closed/merged association; modern records use array order and legacy records retain reportedAt/number compatibility, with URL-derived numbers preferred. This uses existing metadata without GitHub requests and preserves the conversation click route.
