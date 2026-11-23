# Snapshot-first workspace invitations

Status: approved · [approval](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.md)
Translation: current

[中文](snapshot-join.zh.md)

## Invitation authority

An independently delivered invitation or QR carries the workspace ID, genesis
hash and one endorsing device's signing public key. The inviter signs a current
permission snapshot and delivers its exact bytes, head attestation and transport
locator through the join mailbox. The mailbox authenticates the publishing
personal device and requires current Owner/Admin membership; its receipt grants
neither membership nor key access.

The joining client accepts only the pinned device's valid signature for the
pinned genesis. That device must be an active Owner/Admin personal device in the
signed state. This is an explicit endorsement trust model: it does not prove that
a malicious endorser told the truth or that a hostile server supplied the newest
state. The existing independently qualified snapshot API remains distinct.

Every following record must extend the verified parent without a gap. The
transport offset is a locator, never an authority. A forged endorser, corrupt
snapshot, missing record or wrong parent fails without advancing durable state.

## Durable reopening and revocation

Persist the imported invitation separately from the exact signed snapshot, then
retain original suffix records and their cursor atomically. Reopening compares
the imported pin, rechecks the snapshot and verifies only its suffix; it does not
replay the genesis prefix. An independently retained local endpoint and the
selected remote checkpoint still prevent a server response from choosing trust.
Full `verifyLedger` audit remains an explicit optional operation.

A bound device proven historically registered by a genuine ledger may read signed
control bytes after revocation, so it can observe its removal. This narrow read
permission grants no content, mailbox, epoch key, write or snapshot-upload access.
Unknown or unbound devices do not gain this exception.

## Implementation boundary

The public workspace facade owns orchestration through explicitly supplied Effect
Layers. The Lab is its first native consumer. Invitation transport and local
SQLite persistence are Lab adapters; this revision does not enable product E2EE.
