# Preserve Provider and runtime identity across ACP import and fork

Status: implemented
Translation: current

[中文](2026-09-28-imported-acp-session-identity.zh.md)

## Abstract

History selection collapsed all configurations of an ACP agent into one family,
leaving imports unbound when several configurations existed. Fork also required a
live runtime id that newly imported snapshots intentionally do not possess. The
implementation now carries an explicit Provider through catalog lookup and import,
and shares native target resolution between continuation and both fork destinations.
It preserves legacy transcript identifiers and source-reported configuration, while
retaining family-level behavior for older daemons and requests.

## Decision

The UI selects a concrete Provider only after protocol negotiation. The daemon
validates its machine/id/type once per request and uses that configuration for
listing, replay and new-import binding. Provider-scoped catalog keys separate
account results; existing import keys remain family-based inside an index filtered
by binding. This avoids rewriting histories or invalidating their stored hash
baselines. Legacy unbound records can be claimed after the selected Provider lists
their source, while another bound account is excluded from matching.

Imported source and owned runtime ids retain separate meanings. A shared pure
resolver prefers the owned runtime, otherwise accepts a non-conflicted source.
Fork uses this same projection for regular and worktree creation. It captures and
normalizes the source runtime configuration alongside the history snapshot, copies
it only when its native identity and last-user-turn fence match, and rebases it to
the forked native id before the final durable commit. Source Role provenance is
not manufactured and Provider defaults do not overwrite imported model selections.

Rejected alternatives were setting the live runtime id during import (which would
change resume semantics), selecting the first same-type Provider (which could use
the wrong account), and renaming historical replay ids (which would break hash
and refresh continuity). No workspace-wide scan/migration is added.

The shared history Provider schema also replaces Electron's handwritten validation,
so custom ACP Providers and exact selections follow the same boundary as RPC.

## Evidence and limits

Behavior tests cross the real SessionDocument/history writer for import and both
fork destinations. They cover explicit selection with two accounts, identical
native ids across accounts, legacy binding repair, invalid/missing selection,
conflicted source rejection, source configuration preservation and user-turn fencing.
Shared protocol/identity and renderer catalog/label suites cover the transport and
presentation boundaries. Package type checks and scoped static checks accompany them.
No real account session was modified and no packaged desktop/manual native-provider
acceptance was run. Existing unbound conversations require a history sync through
the intended Provider before fork; unavailable native capabilities remain unavailable.

Related: [streaming fork contract](2026-09-11-streaming-fork-affordance.md) and
[Grok native fork](../feature/2026-09-24-grok-session-fork.md). The new
[Spec](../../../../specs/imported-acp-session-identity.md) remains draft.
