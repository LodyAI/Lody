# Agent notes as maintained decision memory

Status: implemented
Translation: current
Supersedes: [explicit note triggers](../../archived/process/2026-09-07-explicit-agent-note-triggers.md)

[中文](2026-10-28-agent-note-memory-hygiene.zh.md)

## Abstract

Agent Notes work as the repository's decision memory, but they only accumulated:
in two months 930 English notes were written, four were archived, and active notes
were frozen at write time, so readers could not tell current guidance from stale
history. Meanwhile a hard 8192-byte `AGENTS.md` gate pushed agents to compress
rules into fragments. Notes are now written only for durable rationale, every new
note runs a supersession check that archives what it replaces, implemented notes
keep their cited facts current, every new note is linked from the README, doc or
Spec that describes the code today, and `AGENTS.md` files have word ceilings that
can be raised with a reason. Bilingual notes and measurement evidence are unchanged;
the existing corpus is not yet pruned, and whether a note is worth writing remains
a judgement that no check can make.

## Problem

Measured on `main` at 2026-10-28 over the previous 500 commits (2026-10-14 to
2026-10-28) and the full note tree:

| Signal                                                       | Value      |
| ------------------------------------------------------------ | ---------- |
| Active English notes (`proposed` + `implemented`)            | 1143       |
| Archived notes                                               | 4          |
| Active `bug-fix` notes                                       | 450        |
| Notes created vs existing notes updated in 500 commits       | 577 vs 210 |
| Commits touching any note                                    | 392 of 500 |
| Commits touching an `AGENTS.md`                              | 226 of 500 |
| `AGENTS.md` files above 8000 bytes                           | 41 of 95   |
| `## Verification`/`Validation`/`Evidence` share of note text | 19.6%      |
| Notes reporting pass counts                                  | 159        |
| Active notes citing a repository path that no longer exists  | 28         |
| `proposed` notes that link a PR                              | 63 of 107  |
| Active notes linked from a README, `AGENTS.md`, doc or Spec  | 337 of 925 |

Four mechanisms produced these numbers. The trigger "every non-trivial change"
required a note for almost every fix, and the rule to search for an owner first
had no consequence, so new notes outnumbered updates. Implemented notes preserved
their historical context, so a moved file or renamed symbol made them silently
wrong, and archiving required a subjective judgement nobody made. Verification
sections recorded pass counts and environment notes that help the PR reviewer
once and nobody afterwards. The byte gate could not be raised, so each new rule in
a full `AGENTS.md` was paid for by shortening existing ones; for example
`apps/cli/src/session/AGENTS.md` changed in 38 of the 500 commits, almost always
with equal added and removed lines.

A sample of the Kimi and Grok notes showed what the numbers mean for a reader. Their
facts still matched the code and their rationale was the most useful content
(why Kimi's plan file is not precreated, why Grok forks through a private method).
But the Kimi Plan behavior was spread over four dated notes, the latest correcting
an assumption of an earlier one, and none was linked from anything an agent reads
before changing Kimi code. The Grok usage-accounting note still said `proposed`
although its PR had merged six weeks earlier. The Grok runtime-pin note, linked
from the CLI agent README's managed-runtime section, was the one that worked as
memory: the README says what is true and the note says why.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) uses the same
lifecycle layout and bilingual notes. Its tree holds 383 active and 927 archived
notes, 17 of them active `bug-fix`, after about five months. The differences that
explain this are a supersession check on every new note, implemented notes kept
current until archived, a narrower creation rule with incidents routed to
postmortems, and word budgets that may be raised with justification.

## Decision

- **Creation rule.** A note records at least one of: a rejected alternative, a
  constraint tests and types cannot enforce, a measurement, a format change, or an
  ownership boundary. A fix that is merely done belongs in its PR and regression
  test. Research that reaches a substantial conclusion still needs a note, which
  keeps the reason the [earlier trigger](../../archived/process/2026-09-07-explicit-agent-note-triggers.md)
  was added: design conclusions without code must not be lost.
- **Supersession on write.** Every new note searches active notes for the same
  decision, updates the owner instead of duplicating it, archives fully replaced
  implemented notes in the same PR and names them under `Supersedes:`, and
  cross-links partial replacements. The [archive skill](../../../skills/archive-agent-notes/SKILL.md)
  carries the procedure and calibrated Lody examples.
- **Implemented means current.** An implemented note is present tense; a change
  that moves or renames something it cites updates that fact in place. The
  decision itself is not rewritten; a reversal is a new note. Archived notes are
  frozen.
- **Owner links.** Every active note is linked from its current-state owner: the
  README section, `.agents/docs/` page, `AGENTS.md` rule or Spec covering that code.
  The owner holds one sentence of current behavior, so several notes about one
  module read as one list. Agents find notes by following these links instead of
  searching dated records, and a link from another note does not count.
- **Maintenance on read.** A task that relies on a note fixes it in the same PR when
  it is stale, unlinked or in the wrong lifecycle; the PR implementing a proposal
  moves it to `implemented/`. Notes are corrected where they are used rather than by
  a separate cleanup schedule.
- **Evidence, not logs.** Measurements, benchmark tables and their conditions stay
  in notes. Verification links what pins each behavior and names what is
  unverified.
- **Word ceilings.** [`agents-budgets.json`](../../../../scripts/docs/agents-budgets.json)
  sets a 1200-word default for every `AGENTS.md`, with per-file overrides. Over a
  ceiling, relocate a topic, condense without losing a rule, or raise the ceiling
  with a reason in the PR. The default sits above the most compressed files (about
  1000 words at 8 KiB); `packages/ui/AGENTS.md` starts with an override because it
  already held 1251 words, and `.agents/notes/AGENTS.md` at 1400 because it is the
  single owner of the note rules this change extends.

`pnpm run docs` enforces the mechanical parts. `check` fails on a ceiling breach, a
`Supersedes` target that is not archived, a new note without an owner link, and a
proposal-era heading (`## Plan`,
`## Acceptance criteria`, and their Chinese forms) in an implemented note. It
warns at 90% of a ceiling and on run-log phrases. Heading and phrase checks apply
only to notes changed against `--base` (CI) or `HEAD` (local), so history is not
reopened. CI passes the first parent of the checked-out merge commit, because
`pull_request.base.sha` can predate main commits merged since and would attribute
their notes to the PR; a lifecycle move is not a new note. `status` lists active notes whose
backticked repository paths are gone (`staleReferences`) and those without an owner
link (`unlinkedNotes`, 589 at introduction, 309 of them `bug-fix`): the work queue
for maintenance on read and topic audits.

This partially supersedes the byte measurements in
[scoped agent instructions](2026-09-08-scoped-agent-instructions.md): chain cost is
still measured, now in words, and that note's relocation decisions stand.

## Alternatives considered

- **Forbid net growth of a file above the warning line.** Rejected by the owner:
  it blocks adding a needed rule and invites the same compression.
- **Make agent notes single-language.** Rejected: bilingual notes are a product
  requirement, and the volume problem is solved by writing and keeping fewer notes.
- **Move benchmark data out of notes.** Rejected: measurements are the evidence a
  future decision needs; only run logs are dropped.
- **Recall by path, and `Paths:`/`Verified:` metadata with drift detection.**
  Deferred. Committing notes with code makes `git log` on a path a usable recall
  index (314 of 430 code commits carried a note), but one CLI session file maps to
  82 notes, mostly noise. Owner links use documents agents already read and need no
  new metadata; recall is worth revisiting once the active set is small.
- **A scheduled corpus audit.** Not adopted as the primary mechanism: a quota-free
  audit of 925 notes is large and goes stale again. Maintenance on read spends the
  effort on notes that are actually used; the archive skill still supports
  topic audits.
- **Copy DeepSeek Harness wholesale**, including hash-sealed archives, line-aligned
  translation sidecars and a separate postmortem tier. Not adopted: each adds
  tooling cost, and the four mechanisms above address the measured causes.

## Consequences

Fewer notes are written, and the remaining ones must be maintained when the code
they cite moves. Writing a note now also means touching its owner document, which
makes the note's subject explicit but costs a second edit. Contributors can no longer satisfy the note rule by appending a
new dated record. Raising a ceiling becomes a visible, reviewed decision instead of
an impossible one. Run-log detection is phrase-based in English and Chinese, so it
both misses paraphrases and flags quoted test names; it only warns.

## Verification limits

[`main.test.mjs`](../../../../scripts/docs/main.test.mjs) covers ceilings and
overrides, malformed manifests, a budgeted file that disappears, proposal headings
and run-log phrases in changed notes only, an unarchived `Supersedes` target, the
stale-reference queue, and owner links (note-only links rejected, either language
accepted, existing notes queued, lifecycle moves exempt). No check judges whether a note was worth writing or
whether a supersession search was thorough, and a link proves only that an owner
names the note, not that its sentence is accurate. The 1143 existing active notes are not
pruned by this change; that is a separate, topic-by-topic application of the
archive skill. This note archives the trigger note it replaces.
