<!--
Fork-based contributions must reference a Lody issue below. Keep the change focused:
all policy findings share one seven-day correction period. A change over 200
lines (additions + deletions) without its prior Issue adds a size-specific finding.
Same-repository branches do not create an Issue solely for contribution intake.

The Issue is for tracking context; maintainers review the contribution through
the normal PR process. Context handoff is public and cannot use N/A or redacted
answers; an invalid body is closed after seven days and must then be resubmitted.
-->

## Related issue

<!--
Required for fork PRs. Same-repository branches may leave this empty. Link the
Issue that provides context for the contribution; prior approval is not
required.
Use `Closes #123` when merging this PR should close the Issue. Use `Refs #123`
only when the Issue must remain open. A bare `#123` or full Lody Issue URL is
normalized to `Closes #123` by the PR policy workflow.
-->

## Problem / pressure

<!-- Required. What constraint, failure, or force made this change necessary? Review against this, not aesthetics. -->

## Summary

<!-- What changed in response to that pressure. Keep this about the change set, not the motivation. -->

<!--
Optional: a diagram, tree, or structural diff often explains a change faster than
prose. Put it directly in Summary or Before / after. Examples and the rules for
choosing a view: .agents/docs/visual-explanations.md
Any supporting artifact must be reachable by reviewers; a local HTML file is not.
Small fixes need no visual. Do not add one for ceremony.
-->

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
