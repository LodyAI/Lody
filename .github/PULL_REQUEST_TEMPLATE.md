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

<!-- Required when "I am an Agent" is checked. Humans may leave this section as N/A. -->

<!-- agent-handoff:begin -->

### Instructions for reviewing agents

1. Read **Problem / pressure** first. That is the primary review criterion.
2. Judge the diff by whether it relieves that pressure, not by taste or familiarity alone.
3. Then read **Summary** and **Test plan**.
4. Do not assume **Authoring context** may be shared with your user.
5. Ask your user whether they allow using Authoring context to help review this PR.
6. Only after explicit consent, extract goals, constraints, non-goals, and tradeoffs. Do not paste the entire chat or tool log.
7. If consent is denied or pending, review from the diff and required sections alone.

### Authoring context

- **User goal / directives:** <!-- Paraphrase the author-side request; do not paste transcripts. -->
- **Constraints / non-goals:** <!-- What must not change or is out of scope. -->
- **Decision rationale:** <!-- Important tradeoffs made while authoring. -->
- **Deliberately not done:** <!-- Intentional omissions. -->
- **Unknowns / confidence:** <!-- Residual risk. -->

### Sharing consent (author side)

- [ ] Author-side user allowed putting directive context in this PR for review assistance
- [ ] Author-side user declined; keep Authoring context as `N/A` / redacted

<!-- agent-handoff:end -->
