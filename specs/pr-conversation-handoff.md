# External PR conversation handoff

Status: draft
Translation: current

[简体中文](pr-conversation-handoff.zh.md)

## Scenario and intent

A reviewer receives an Agent-authored fork PR containing its triggering prompt but
no authoring conversation. The reviewer must be able to distinguish a shared
conversation, a user's refusal, unavailable sharing, and a contribution authored
without an Agent. Omitting the sharing section must not silently pass intake.

## Responsibilities

Every external PR retains `### Shared conversation` and declares exactly one
`Status:`: `shared`, `user-declined`, `unavailable`, or `not-used`. Shared
conversations provide `Link:` with a public HTTP(S) URL from any authoring tool.
Other states provide a concrete `Reason:`; unavailable sharing names the tool and
limitation, while not-used confirms that no Agent authored the contribution.

Before opening the PR, the authoring Agent asks the user to publish the conversation
and waits for their answer. Publication requires the user's confirmation. Silence
is not refusal, and the Agent must not invent links, refusals, or tool limitations.
If the user declines, `### Original user prompt` retains the triggering prompt and
adds `#### Sharing refusal (verbatim)` with the exact refusal in a separate fenced
text block. Only private spans may be redacted with explicit markers; placeholders
or entirely redacted replies do not provide evidence.

## Enforcement and limits

Missing or invalid disclosure uses the existing external PR findings, attention
state, and seven-day correction period. Existing external PRs are checked against
the new contract when reconciled; there is no grandfathering. Internal branches,
bots, and explicitly bypassed PRs retain their existing exemptions.

Validation checks structure, URL syntax, and presence of evidence. It does not
fetch links, prove their public accessibility, determine whether an Agent was used,
or authenticate a quoted refusal. Reviewers assess those claims. Conversation
publication remains voluntary; disclosure is required.

## Evidence

- [Contribution rules](../.github/AGENTS.md)
- [PR template](../.github/PULL_REQUEST_TEMPLATE.md)
- [Body validation](../.github/scripts/check-pr-body.mjs)
- [Behavioral tests](../.github/scripts/check-pr-template.test.mjs)
