# Composer configuration during attachment preparation

Status: implemented
Translation: current
PR: [#1160](https://github.com/LodyAI/Lody/pull/1160)

[中文](2026-09-30-composer-pending-send-config.zh.md)

## Abstract

A held attachment send already froze its configuration, but a newly opened
composer read only synchronized history and queue sources and therefore displayed
provider defaults until the upload finished. The composer now derives a temporary
baseline from the latest local held send, preserving explicit edits for the next
draft. The held send and its written turn share one logical identity for draft
fencing. This keeps selection continuous without adding durable state or changing
the frozen send; packaged-device behavior remains unverified.

## Decision and ownership

This completes the UI configuration handoff after [removing the send journal](../simplification/2026-09-29-remove-session-send-journal.md).
The [attachment Spec](../../../../specs/session-files.md#61-send-boundary) owns the
intended behavior; [run-config documentation](../../../docs/sessions-run-config.md)
explains its integration with ordinary selection and Role provenance.

`useSessionPendingConfig` subscribes to the latest frozen entry for one session,
not to attachment progress. It supplies configuration and Role source fences to
`session-chat-interface.tsx`. An older runtime baseline cannot override this local
source. Selection remains a pure derivation over inputs and user edits.

When a written history turn has not reached the rendered source snapshot yet,
the hook retains the frozen entry until the matching Turn appears. Cancellation
has no landed turn and releases the temporary source. A newly observed durable
Turn supersedes an older local source permanently; removing that durable Turn
cannot resurrect it. Scope identity includes both session and pending-send store.

The preference revision uses the logical Turn key for both the held send and its
history/queue row. A source-kind transition therefore cannot consume an explicit
next-draft edit, even when its value equals the submitted value. Role receives the
same baseline and lineage as the other controls. Desktop and mobile keep their
normal configuration faces while submission disables menus or sheets.

Keeping only the old simplified label would still omit models advertised through
ACP config options and would drop Role identity. Freezing the whole visible
composer would prevent independent editing of the next draft. Reusing the current
control faces and the existing frozen entry addresses both boundaries.

## Verification and limits

Behavioral tests extend the existing configuration and control-face suites using
synthetic messages, the real pending-send store and controlled preparation promises.
They cover an empty hydrating document, continuation runtime fencing, history
publication lag, explicit next-draft edits, failure/cancellation, multiple local
sends, session switching and durable supersession. Face tests cover ACP-only model
labels, Role identity and disabled mobile configuration.

No native-device or daemon-delivery acceptance is claimed. Component type checking
is limited by dependencies missing or older than this checkout's lockfile; document
checking has pre-existing links into uninitialized ACP submodules. The change adds
no persistence, transfer protocol or message-write path.
