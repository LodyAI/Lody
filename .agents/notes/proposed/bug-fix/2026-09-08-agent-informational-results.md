# Preserve informational agent results

Status: proposed
Translation: pending

## Abstract

A Pi command can finish successfully without starting a model turn. Desktop
acceptance showed that answered questions had saved their answers, but Lody marked
the command as failed because the adapter sent no visible result. The proposed
fix projects native completion through Core's existing informational notice and
completes Lody's consumer of that contract. It preserves the protection against
adapters that silently swallow model failures.

## Ownership and evidence

[The behavior draft](../../../../specs/agent-informational-notices.md) describes
what the user should observe. Pi owns native completion: command handler return,
followed by accepted RPC, drained events and no started or pending agent run.
Errors and cancellation remain separate outcomes. Core already defines notice
levels; Lody owns their persistence and presentation through its existing notice
queue and history gate.

Real Pi experiments confirmed four branches: answered command and consumed input
had no updates before the fix and each produced an info notice in the candidate;
a throwing command still rejected, and an empty model result still had no
completion notice. An informational result describes input processing only, not
success of arbitrary external side effects.

The current Host accepts the info schema but discards its notification. Its
warning recorder also deduplicates equal messages across a session. The same
pipeline should retain severity and each informational occurrence while keeping
legacy warning behavior. The durable agent_warning name remains compatible; no
second store, queue or migration is needed.

## Alternatives and limits

A completed tool call would incorrectly imply a model-requested operation. A
fallback assistant message would misattribute the result. An empty update would
only bypass the output counter, and a new response outcome protocol would add a
contract and still leave the user without a result. Counting a displayed question
as success would hide errors that occur after the answer.

This Host change is independent of MCP opt-out and Stop/steer ownership. It belongs
to the Pi integration tracked by [#451](https://github.com/LodyAI/Lody/issues/451).
A single consumer round-trip regression protects repeated informational results,
old warning compatibility and schema preservation; deleting the level schema
field makes it fail. Independent consumer review passed 145 related tests with
no P0/P1. Full workspace checks, formatting and documentation checks passed.
Final desktop acceptance remains pending.
