# Lody automatic notifications and independent channel delivery

Status: proposed
Translation: current

[简体中文](2026-10-13-agent-native-attention.zh.md)

## Abstract

Lody determines notification eligibility from trusted execution outcomes and input authors, without an agent notification tool, Inbox UI or new Web delivery. Desktop and mobile submit independently and may both alert. The implementation keeps a small shared policy and compatible adapters, with no device heartbeat, retry queue or cross-device arbitration. Current Live Activity producers are silent. Code and local tests exist; actual device display, sound and click acceptance remain outstanding.

## Source policy and minimal contracts

The [shared module](../../../../packages/shared/src/notifications/index.ts) holds source facts, AttentionItem, a shared terminal payload schema and stable provider identity. MessageHandler uses the actual policy result's recipient, source and outcome. It does not import a generic intent/router/receipt framework or create an Inbox store.

The execution owner emits succeeded, failed, cancelled or unknown from the real terminal path, freezing requester and exact input author per invocation. Human success/failure/unknown outcomes may alert; cancellation, ordinary delegated output and unknown audiences do not. RPC provenance remains unknown until the existing history writer reads that exact input, without a new pre-prompt scan.

Session containment does not determine a turn's audience. Automatic Inbox-only continuations combine multiple operations and have no single human author: they explicitly remain unknown and silent. Human input with attached Inbox results retains its own frozen audience. Preserve the existing operation Inbox and cancellation lifecycle; notification failure must never replay agent work. See [session relations](../../../../specs/session-relations.md) and [orchestration rules](../../../../apps/cli/src/orchestration/AGENTS.md).

Schedules currently produce ordinary user turns. Success/failure/unknown follow the same policy and cancellation is silent; high-frequency schedules may alert every run. Conditions, digests, health episodes and prehandoff alerts are deferred.

## Independent best-effort delivery

Each permitted target receives one bounded attempt. Failure, timeout, reconnection or a later lock does not retry or switch channels. Desktop activity, DND, disabled notifications or a visible source cannot suppress mobile. Two devices each alerting is accepted normal behavior, not only a rare race.

The control document stores only the latest terminal notification. Metadata carries a low-frequency 36-byte UUID activation index; the desktop reads only changed sources, with four concurrent reads and a five-second deadline. Startup/reconnection establishes a baseline instead of replaying history. Recipient, identity, freshness, current settings and current source visibility are checked before display.

Mobile remains an optional authenticated cloud capability and uses generic terminal/permission copy without private titles or raw errors. Current protocols target permitted native subscriptions; legacy protocols retain their existing target behavior. Acceptance is not proof of device display or user reading. Local-only composition never acquires product-cloud notification capability.

The removed desktop sampler, presence heartbeats, arbitration and notification journal are not reserved as empty interfaces. There is no outbox, route epoch, claim, cross-device read protocol or dedicated notification runtime.

## Compatibility and silent activity

`terminalNotifications` capability disables idle-completion inference for new CLI peers. `LegacyElectronSessionNotifier` isolates old idle completion and current permission observation, using the same host snapshot. Remove idle fallback only when the minimum supported CLI has the capability; retire permission observation separately when typed request projections replace it.

Cloud capability negotiation preserves legacy success/permission arguments, skips unsupported failure/unknown outcomes and never retries through a legacy fallback after submission. Internal `notifyTurnOutcome` naming does not rename deployed cloud actions, ports or IPC. Additive persisted fields, provider identity bytes and optional IPC arguments preserve old clients.

The mobile summary hook never attaches permission alerts and keeps updating other work while permission is pending. Permission candidates only flush the throttled snapshot. Keep the original one-second input throttle, 250ms bridge debounce, native/settings gates, empty-summary behavior and scope teardown. The optional bridge alert field remains readable for legacy clients. Ordinary Push owns reminders independently of activity success.

## Architecture and verification limits

Ordinary types and pure functions suffice; no XState or new Effect Runtime is introduced. Existing SessionDocument/CloudPort and React bridge ownership are not a completed native Effect unit; wrapping those unfinished lifecycles would not complete a migration. Tests exercise policy, real execution and schedule preparation, shared CRDT compatibility, mounted desktop/activity consumers and mixed-version adapters.

New global/per-source mute controls, mobile foreground-source suppression, delegated blocker aggregation, fine-grained activity subscriptions and remote activity ordering are deferred. Source pages retain their existing errors and requests. Native display, sounds, click navigation and mixed-version device acceptance still require verification; local tests and builds do not establish delivery. The [native notification lifetime fix](../../implemented/bug-fix/2026-09-20-notification-click-lifetime.md) remains valid.
