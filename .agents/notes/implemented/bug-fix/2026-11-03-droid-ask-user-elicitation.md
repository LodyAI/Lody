# Preserve Droid AskUser questions and answers

Status: implemented
Translation: current

[中文](2026-11-03-droid-ask-user-elicitation.zh.md)

## Abstract

Droid's AskUser form assigns internal option IDs and keeps custom text in a companion
field. Treating it as a legacy Claude form hid the question, displayed IDs as options,
and returned invalid custom answers. The shared bridge recognizes Droid's complete form,
keeps the user-facing labels in durable question metadata, and translates submitted
answers back into Droid's IDs and companion fields. Other form shapes retain their
existing interpretation. The question card renders distinct short headers above the
question, and treats custom text as a replacement for selections, including on
multi-select questions; it does not offer combining them.

## Decision

Droid 1.1.0 emits the fixed message `Droid needs your answers to continue.`, required
`question_N` fields and, for choices, an optional `question_N_other` companion.
Single-select options use `oneOf`, multi-select uses `items.anyOf`, and each has an
`other` option. The bridge accepts this identified shape only when its fields, option
IDs and unique labels can be mapped without ambiguity; malformed forms are declined.
The original request retains the label-to-ID map while permission history stores the
normal Core question and human-readable answer. Custom text becomes `other` plus the
companion, and missing or invalid required answers cancel rather than produce an
invalid accepted response. The mapping handles a mixed list of selections and custom
text if another compatible client supplies one, without changing the card's interaction.

The generic Claude and Core paths retain their existing message, custom-answer and
note semantics. No new provider capability, stored answer format, or UI control is
introduced. The exact Droid message and shape are a compatibility boundary. A recognized message
with an unexpected shape is declined; a different message follows the generic path
and must be revalidated if Droid changes its protocol.

## Verification

[Shared behavior tests](../../../../packages/shared/tests/ask-user-question.test.ts)
exercise single and multi-select, free text, custom and malformed forms, and durable
permission history. The [card test](../../../../packages/components/tests/ask-user-question-card.test.ts)
exercises presentation and submission through the actual parser. The [CLI boundary test](../../../../apps/cli/tests/agent-client-plan-mode.test.ts) verifies the request and custom-answer response through AgentClient. The form was checked
against functions extracted from Droid 1.1.0's official distributed binary; a live
Droid account and end-to-end desktop session remain unverified.
