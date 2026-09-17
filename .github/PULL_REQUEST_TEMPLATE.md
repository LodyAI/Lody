<!--
Fork-based contributions must reference a Lody issue below. Keep the change focused:
all policy findings share one seven-day correction period. Community PRs over 1000
lines (additions + deletions) need a maintainer assignment on the linked Issue;
over 200 without its prior Issue adds a size-specific finding. Same-repository
branches do not create an Issue solely for contribution intake.

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

## Visual explanation

<!--
Required. Agents: invoke `$show-me` and place its smallest useful view here.

Complex changes must include a structural view: Mermaid, pseudocode/call tree,
component/file tree, structural diff, image, or a linked reviewable HTML artifact.
A change is complex when it crosses component/runtime/authority boundaries, changes
multi-step control or data flow, or exceeds 200 changed lines. The automated policy
enforces the 200-line floor; reviewers enforce the semantic cases.

For a simple change, write `Simple change: <why a visual would not help review>`.
Examples and selection rules: .agents/docs/visual-explanations.md
Any supporting artifact must be reachable by reviewers; a local HTML file is not.
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
agents the minimum public context needed to assess intent and risk. N/A and
redacted answers are not accepted. Never paste private transcripts, secrets, or
tool logs; link a published shared conversation instead of copying its text.
-->

<!-- context-handoff:begin -->

### Original user prompt

<!--
Required only for fork-based/external pull requests. Same-repository maintainer
branches do not need to provide an original user prompt.

For external PRs, preserve the triggering user's prompt as source evidence for
review. Paste it verbatim: do not summarize, rewrite, clean up, or translate it.
If the prompt contains secrets or private material that cannot be published,
redact only those spans and leave an explicit marker in their place. Do not append
unrelated transcript turns, tool logs, or attachment bytes.
-->

<details>
<summary>Show original prompt</summary>

````text
<!-- Paste the triggering user's original prompt here, verbatim. -->
````

</details>

### Shared conversation

<!--
Optional. If the authoring conversation was published as a shared Lody
conversation, paste the public link here so reviewers can inspect the complete
authoring context the summary omits. Otherwise delete this section entirely.

An Agent asks its user to publish the conversation before opening the pull
request and pastes the returned public link here. Publication needs the user's
confirmation in the app; the Agent requests it but never approves it and never
invents a URL.
-->

<!-- context-handoff:end -->
