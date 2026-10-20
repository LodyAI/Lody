# Hide contentless operation success receipts

Status: implemented
Translation: current

[中文](2026-10-20-hide-empty-operation-receipts.zh.md)

## Abstract

Creation progress already identifies a completed target, but its deduplicated
completion rendered another generic success card. Hide that contentless receipt
and a fully represented batch containing only hidden receipts. Concrete session
cards and failure, cancellation, uncertain delivery and omitted-preview information
remain visible. This changes presentation only, with component execution still
unverified in the dependency-free checkout.

## Decision and evidence

Keep the durable Inbox contract from the
[Inbox decision](../architecture/2026-10-12-operation-inbox.md).
`operation-completion-visibility.ts` shares the projection between system rows,
batch members and virtual rows, so hidden batches leave no virtual spacer.
Existing progress suppresses successful creation targets, but not problem details.
An unknown delivery or incomplete member preview retains its batch header because
the visible preview cannot establish that all information is redundant.

Retaining the generic success shell adds no target information; hiding every
completion would also hide actionable failures and chat replies. The selected
rule preserves the existing concrete cards and leaves history/model inputs intact.

## Verification

Seventeen direct Node assertions against the production projection pass, covering
concrete and empty results, linked progress, chat replies, errors, cancellation,
mixed results, delivery states and omitted members. The owning relation-card suite
now covers empty virtual-row removal and preserved failure/uncertainty rendering.
Its run cannot start because this checkout has no installed Vitest/dependencies;
no dependency installation, browser validation or full test pass is claimed.
