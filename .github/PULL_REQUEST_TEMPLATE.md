<!--
Fork-based contributions must reference a Lody issue below. Keep the change focused:
all policy findings share one seven-day correction period. A change over 200
lines (additions + deletions) without its prior Issue adds a size-specific finding.
Same-repository branches do not create an Issue solely for contribution intake.

Creating or linking an Issue is not permission to implement the change. Wait
for a Lody maintainer to explicitly agree on the scope and approach before
starting implementation or opening the PR. Automation checks only the Issue
reference; maintainers decide whether prior agreement is sufficient.

Agents authoring fork-based contributions MUST explain these consequences to the
author-side user before implementation: a newly created Issue is not approval
and work must wait for explicit maintainer agreement; Context handoff is public
and cannot use N/A or redacted answers; an invalid body is closed after seven
days and must then be resubmitted. Do not claim notice or agreement happened
unless it did.
-->

## Related issue

<!--
Required for fork PRs. Same-repository branches may leave this empty.
Use `Closes #123` when merging this PR should close the Issue. Use `Refs #123`
only when the Issue must remain open. A bare `#123` or full Lody Issue URL is
normalized to `Closes #123` by the PR policy workflow.
-->

## Problem / pressure

<!-- Required. What constraint, failure, or force made this change necessary? Review against this, not aesthetics. -->

## Summary

<!-- What changed in response to that pressure. Keep this about the change set, not the motivation. -->

## Before / after

| Before | After |
| ------ | ----- |
| ...    | ...   |

## Test plan

<!-- Concrete verification: commands run, checks observed, and what was skipped. -->

## Context handoff

<!--
Required for every fork-based pull request. Give maintainers and their reviewing
agents the minimum public context needed to assess scope, intent, and risk.
Every field must contain a concise, meaningful summary; N/A and redacted answers
are not accepted. Never paste private transcripts, secrets, or tool logs.
-->

<!-- context-handoff:begin -->

### Instructions for reviewing agents

<!--
Required and PR-specific. The authoring Agent writes this handoff for the
organization owners' reviewing Agent. Do not paste a generic review checklist.
Keep each item to one concise sentence and the whole section under 1,200
characters. Include only the highest-value files, decisions, risks, and gaps.
-->

- **Review focus:** <!-- Which concrete files or flows deserve attention, and why? -->
- **Decisions to challenge:** <!-- Which deliberate choices need independent judgment? -->
- **Plausible failures / evidence gaps:** <!-- What material breakage or uncertainty remains? -->

### Authoring context

<!-- Fill every field with a public summary. Explain briefly when there is no applicable risk or omission. -->

- **User goal / directives:** <!-- Concise paraphrase only; never paste transcripts or tool logs. -->
- **Constraints / non-goals:** <!-- What must not change or is out of scope. -->
- **Risk-bearing decisions:** <!-- Decisions affecting data, authority, compatibility, or recovery. -->
- **Destructive or irreversible behavior:** <!-- Include cleanup, overwrite, migration, rollback, and failure recovery. -->
- **Deliberately not done or tested:** <!-- Intentional omissions and why they are acceptable. -->
- **Unknowns / confidence:** <!-- Residual risk and confidence in the change. -->

<!-- context-handoff:end -->
