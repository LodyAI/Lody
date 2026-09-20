# Ask Question answer notes

Status: draft
Translation: current

[中文](ask-question-answer-notes.zh.md)

## Scenario and contract

A user can select an answer and add optional context without replacing the answer.
Lody consumes the public Core 0.1.6 contracts through its workspace submodule.
Standard ACP `elicitation/create` carries the form. A string property with
`_meta.lody.elicitation: { version: 1, noteFor: "questionId" }` becomes the
question's Core `note`, retaining its schema key, title, description and secret flag.
`customAnswerFor` remains a replacement answer. The adapter supplies all options,
including an explicit None of the above when appropriate.

Notes cannot satisfy a required main question. Choosing an option retains the
note; entering a note does not activate replacement-answer mode. Questions with
notes stay on the current page after selection so users can finish the note.
Submission is explicit; cancellation discards the draft response.

Question and note values use separate keys in the existing `answers` map and ACP
`content`. Notes must be strings; empty or whitespace-only notes are omitted.
Existing string and string-array answers remain compatible. Reject missing,
self, chained, duplicate or mixed note/custom associations and non-string note
properties. A note key cannot overwrite a question or another note. Never derive
associations from an `_note` suffix.

## Ownership and compatibility

```text
ACP form → shared parser → Core question + note
                          ↓
                 question card drafts
                          ↓
          permission outcome / HistoryWriter
                    ↙             ↘
              ACP content      history replay
```

The shared parser validates associations both at the form boundary and when
reading persisted normalized metadata. The card keeps independent drafts and
masks secret notes separately from main answers. History retains the two values
without a storage migration; old records without notes retain their presentation.
Secrets are visually masked, not removed from the underlying answer record.

The session ACP client advertises standard `elicitation.form` and Core
`clientCapabilities._meta.lody.elicitation: { version: 1, answerNotes: true }`
only with the complete parse/edit/submit/persist/replay implementation.
Authentication elicitations do not advertise this capability. Adapters remain
responsible for their legacy fallback for clients that omit it. A separately
running older renderer is not upgraded by this CLI advertisement.

## Evidence

- [Core published contract](../packages/acp-extension-core/README.md#elicitation-answer-notes-016)
- [Shared bridge and history tests](../packages/shared/tests/ask-user-question.test.ts)
- [Component behavior tests](../packages/components/tests/ask-user-question-card.test.ts)
- [Real component stories](../packages/components/src/stories/AskUserQuestionCard.stories.tsx)
- [Implementation decision](../.agents/notes/implemented/feature/2026-09-20-ask-question-answer-notes.md)
