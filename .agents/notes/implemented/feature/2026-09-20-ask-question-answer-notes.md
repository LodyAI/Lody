# Separate Ask Question notes from replacement answers

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/837

[中文](2026-09-20-ask-question-answer-notes.zh.md)

## Abstract

Lody already bridged ACP forms onto durable permission questions but discarded
Core answer notes. The existing bridge now validates explicit note associations,
keeps independent card drafts and retains both fields through answers and history.
This avoids a second storage or response protocol while preserving old replacement
answers. Client negotiation enables notes only on the session question path;
older independently running renderers remain outside that upgrade guarantee.

## Decision and evidence

The pinned Core commit `bb9632c929dfdbfb650619e3719a11be1808d4d1` already
contains 0.1.6, also verified on npm. No dependency or lockfile bump is necessary.
[Codex PR #47](https://github.com/LodyAI/acp-extension-codex/pull/47) merged
on 2026-09-18 as `a0f1c78f5ca324881805e0c355102952394e9fbc`; its head is
`214723488b4bd5e9ffcb0c2266fd3c9bfb2434ea`. The pinned Codex submodule contains
that merge. AIR and provider-native answer translation are outside this change.

Schema keys, not suffix conventions, associate the note. Invalid references fail
closed instead of becoming standalone questions or overwriting another answer.
Normalized history metadata is checked again before presentation. Explicit
per-question custom-answer flags prevent a different free-text question from
enabling replacement mode on an option-only question.

The existing permission outcome and HistoryWriter carry Core's unchanged
`string | string[]` answer map. Notes narrow their own entries to nonempty strings.
Using the existing path avoids parallel persistence; reinterpreting
`customAnswerFor` would break old records and is forbidden by Core.
Secret notes and free-text answers are masked independently in read-only cards.
Selection no longer auto-advances a question that offers a note.

This adds to the [single history writer decision](../architecture/2026-09-07-single-history-writer.md)
without changing storage ownership. Product intent is in the
[draft Spec](../../../../specs/ask-question-answer-notes.md).

## Verification and limits

### Ablation of the implementation

Each candidate was applied separately and tested before retaining it; removals
were cumulative after passing. The baseline passed 47 shared and 15 component
tests. Five additional persisted-metadata cases (duplicate/missing/blank question
ids, duplicate notes and collision with a later question) passed before and after
the explicit-id simplification. Test success is paired with the data-flow argument
below; it is not treated as proof that arbitrary validation is removable.

| Candidate | Observation and decision |
| --- | --- |
| Remove duplicate-association rejection | One existing test failed: the later note overwrote the first. Restored the guard. |
| Reuse the collected auxiliary-field set when filtering questions | 47 shared tests passed. The filtered question set already excludes auxiliary keys, so its membership check also rejects chains without another auxiliary lookup. Kept. |
| Remove legacy answer-key derivation from note-key validation | 52 shared tests passed. Note-bearing records require unique, nonempty explicit ids, making fallback derivation and its repeated uniqueness scans redundant. Kept direct id validation. |
| Remove repeated note trimming and question lookup in response construction | 52 shared, 15 component and 60 CLI tests passed. Extraction already omits blank notes; the iteration already supplies the current question. Kept. |
| Merge absent-answers and absent-value draft initialization | 15 component tests passed. Optional lookup reaches the same empty-draft branch while retaining note-only data. Kept. |

Association rejection, read-boundary validation, separate note drafts, masking
and legacy compatibility remain. This cleanup changes no Spec guarantee and
makes no measured performance claim.

### End-to-end validation

Behavioral coverage exercises shared parsing, malformed associations, suffix
collisions, replacement answers, cancellation, HistoryWriter snapshot reopen,
real React editing, readonly secret masking, CLI bridging and initialization.
Dedicated stories use the production card; their readonly fixtures are also
rendered by the component suite. `pnpm check`, formatting and document checks
passed. Focused suites passed 47 shared, 15 component and 60 CLI tests. CLI build
passed with a 2 GiB heap; Electron application build passed with its default heap.
Storybook started and indexed all five stories. Graphical desktop/mobile acceptance
remains unverified: the available UI connection had no browser and could not obtain
a Chrome window. No npm publication or merge is performed.
