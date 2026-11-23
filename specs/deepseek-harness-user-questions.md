# DeepSeek Harness user questions

Status: draft
Translation: current

[中文](deepseek-harness-user-questions.zh.md)

## Behavior

When a live root Harness Agent invokes `ask_user_question`, Lody presents its
existing Ask Question card and returns the submitted answers to the waiting tool.
The selected preset still determines whether the model has this tool; `minimal`
does not gain it. Questions remain interactive regardless of permission mode.

The DSH adapter owns native-to-ACP translation. Standard `elicitation/create`
and Core `_meta.lody.elicitation` reuse the existing host parser, interaction,
and answer persistence. No DSH-specific host/UI protocol is introduced.
Question ids and option labels round-trip unchanged. Multiple questions,
single/multiple selection, free text, and Other are supported. Multi-select
choices may accompany custom text when the client advertises Core answer notes;
older clients retain replacement-only Other. Generated form keys and the
custom-only UI option cannot collide with native ids or option labels.

Plan-review intent displays the question and complete plan detail through the
generic question card. The adapter returns the selected labels, including the
declared approval label, without changing Plan Mode or permission policy.

Harness retains exact live-agent and runtime-root validation. The adapter claims
only its own Agent-scoped requests. Requests queue per session; another session
has an independent queue. Abort/cancel/close releases active and queued tools,
skips cancelled waiters, and discards late replies. User decline, malformed
answers, unsupported clients, and transport failures become tool failures rather
than successful empty answers or implicit approval.

## Limits and evidence

SDK 1.3's legacy AgentSideConnection cannot cancel an individual outgoing form
request. A tool abort releases the adapter waiter but the host may retain the
already-sent card until dismissal or turn cancellation. This revision does not
promise immediate card removal for independent tool aborts.

- [Provider implementation and compatibility](../packages/acp-extension-dsh/README.md#user-questions)
- [Core answer-note contract](ask-question-answer-notes.md)
- [Implementation and verification](../.agents/notes/implemented/feature/2026-09-20-dsh-user-questions.md)
