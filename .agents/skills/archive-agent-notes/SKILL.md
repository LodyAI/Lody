---
name: archive-agent-notes
description: Use when adding, auditing, pruning, archiving or reviewing Lody Agent Notes. Runs the supersession check every new note requires, deletes records of small UI or purely mechanical changes, classifies implemented notes by future decision value, rejects obsolete proposals, prunes rejected notes that no longer prevent a plausible mistake, and applies the archive procedure.
---

# Archive Lody Agent Notes

Notes are the repository's decision memory. This workflow keeps the active set
(`proposed/` and `implemented/`) small enough to search and current enough to
trust, without losing history that can still guide work. Judge every note by its
future decision value. Word count, age and inbound-link count are discovery aids,
never criteria, and there is no quota.

## Read the contracts

Read the [note rules](../../notes/AGENTS.md) and [document maintenance](../../README.md).
Establish whether a rationale still owns or constrains anything from current code,
Specs, `.agents/docs/`, owning READMEs, newer notes and inbound links, not from
the note's own claims.

## Supersession check for a new note

Run this before drafting any note, scoped to the decision being recorded:

1. Search active notes for the same decision, mechanism, file paths and rejected
   alternatives. Search titles and abstracts first; `git log --name-only` on the
   changed source paths finds notes committed with earlier changes to them.
2. If one note already owns the decision, update it. Do not create a second note.
3. For each implemented note the new decision fully replaces, carry every unique
   rationale, alternative, measurement and reintroduction condition into the new
   note, archive the old pair, and list it under `Supersedes:` in the new note's
   metadata, linking the archived path.
4. For a partial replacement, keep both active, cross-link them, and correct the
   facts in the older note that the change made stale.
5. Reject a proposal the new decision makes obsolete; never archive a proposal.

Do not defer a known match to a later audit.

## Classify by future value

Apply these outcomes per lifecycle:

- **Implemented, delete:** the note records only a small UI adjustment, a local
  interaction fix or a purely mechanical change. Delete both languages and repair
  or remove inbound links. Apply this test first.
- **Implemented, keep active:** its rationale, rejected alternatives, negative
  guarantee, durable or wire semantics, ownership boundary, security rule,
  measurement or reintroduction condition is likely to guide a future change.
  Classify the decision, not the size of its implementation.
- **Implemented, archive:** a substantive decision that is complete and unlikely
  to guide future work, but whose rationale still has historical value.
- **Proposed, reject:** the work is no longer worth pursuing or has been overtaken.
  Move the pair to `rejected/` with the reason. A proposal whose PR merged is not
  obsolete; move it to `implemented/` and rewrite its plan into the present tense.
- **Rejected, keep:** the losing idea remains a tempting, meaningful mistake and
  the note explains why it loses.
- **Rejected, delete:** the idea is obsolete, superseded or no longer plausible.

Classify analogous notes under one principle, use judgement for close cases, and
report genuinely borderline ones. A note kept active must end the change linked
from its current-state owner (README, `.agents/docs/` page, `AGENTS.md` or Spec)
with one sentence of what is true now; `pnpm run docs status` lists active notes
that lack one (`unlinkedNotes`) and is the discovery list for a topic audit.

## Calibrated examples

These set the bar. The sizes show that length is not the test.

Delete:

- `bug-fix/2026-09-21-model-search-focus` (388 words): a local menu focus fix; its
  regression lives in the browser suite and the run-config doc owns the overview.

Keep active:

- `bug-fix/2026-10-22-node-security-runtime-floor` (598 words): the root
  `AGENTS.md` cites it as the rationale for a binding version floor.
- `architecture/2026-10-12-operation-inbox` (3931 words): an ownership and
  admission contract other notes and `AGENTS.md` files depend on.

Archive:

- `bug-fix/2026-10-27-e2ee-cli-review-fixes` (512 words), once the E2EE CLI
  decisions it closes are owned by a current note or `.agents/docs/` page: it is a
  review-fix batch whose lasting rules belong to those owners.
- `simplification/2026-09-10-goal-control-ablation` (20871 words): the adopted
  simplifications shipped; its per-file ablation matrix is historical evidence,
  not current guidance.

Rejected:

- Keep `bug-fix/2026-09-18-codex-transient-reasoning`: it shipped and was reverted,
  and routing transient reasoning outside history remains a tempting shortcut.
- Keep `architecture/2026-10-10-provider-prompt-receipts` only while durable
  native admission receipts remain a plausible misreading of the delivery request.

## Archive one implemented pair

1. Move `foo.md` and `foo.zh.md` from `implemented/<type>/` to `archived/<type>/`.
2. Make no body edits. Insert the same `Archived: YYYY-MM-DD` line immediately
   below `Status: implemented` in both files.
3. Search for inbound links from active documents. Redirect them to the current
   owner, retarget them to the archived path only where history is cited on
   purpose, or delete them. Link repair inside the archived note itself is allowed
   only for a broken target, never to update its facts.
4. After sealing, do not edit, translate, reformat or move the pair.

## Validate and report

Run `pnpm run docs check` and `pnpm format`. Report notes kept, deleted, archived
and rejected, and every borderline case with the outcome you chose.
