## Author type

- [ ] I am an Agent (check this if an LLM agent authored this PR)
- [ ] I am a human

## Problem / pressure

<!-- Required. What constraint, failure, or force made this change necessary? Review against this, not aesthetics. -->

## Summary

<!-- What changed in response to that pressure. Keep this about the change set, not the motivation. -->

## Test plan

<!-- Concrete verification: commands run, checks observed, and what was skipped. -->

## Agent handoff

<!--
Required when "I am an Agent" is checked.

Before opening or updating this PR, the authoring Agent MUST ask the author-side
user whether a concise paraphrase of Authoring context may be published. Never
infer consent. Check exactly one Sharing consent option below. Humans may leave
this section unchanged or mark it N/A.
-->

<!-- agent-handoff:begin -->

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

<!-- Fill every field after explicit sharing consent. Use "None" where genuinely applicable. -->

- **User goal / directives:** <!-- Concise paraphrase only; never paste transcripts or tool logs. -->
- **Constraints / non-goals:** <!-- What must not change or is out of scope. -->
- **Risk-bearing decisions:** <!-- Decisions affecting data, authority, compatibility, or recovery. -->
- **Destructive or irreversible behavior:** <!-- Include cleanup, overwrite, migration, rollback, and failure recovery. -->
- **Deliberately not done or tested:** <!-- Intentional omissions and why they are acceptable. -->
- **Unknowns / confidence:** <!-- Residual risk and confidence in the change. -->

### Sharing consent (author side)

Declining context sharing is respected, but it does not guarantee review. If withheld context prevents maintainers from assessing provenance, scope, or risk, they may decline the contribution or close the pull request.

- [ ] Author-side user explicitly allowed publishing the Authoring context above
- [ ] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as `N/A` / redacted

<!-- agent-handoff:end -->
