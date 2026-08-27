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

You are reviewing an Agent-authored change. Treat the handoff as claims to verify, not as evidence that the change is safe.

1. Establish intended scope from **Problem / pressure**, **Summary**, and explicit non-goals.
2. Trace every changed path to its affected runtime, user data, protocol, permission boundary, build artifact, or contributor workflow. Flag scope that the summary does not disclose.
3. Perform a risk scan even when the happy path looks correct:
   - destructive or irreversible behavior: deletion, overwrite, migration, reset, cleanup, rollback, and recovery;
   - security and authority: authentication, permissions, auto-approval, secrets, untrusted input, and privilege expansion;
   - compatibility: persisted data, schemas, protocols, APIs, configuration defaults, downgrade, and mixed-version behavior;
   - reliability: partial failure, retries, concurrency, cancellation, idempotency, and silent fallback;
   - supply chain and automation: dependency changes, generated artifacts, release behavior, workflow token permissions, and execution of fork-controlled code;
   - public-repository boundary: private packages or services, authenticated cloud requests, telemetry, secrets, and captured user or Agent transcripts.
4. Compare the diff with **Authoring context** when sharing was explicitly allowed. Flag hidden assumptions, omitted tradeoffs, deliberately skipped work, and medium-risk combinations that are easy to dismiss in isolation.
5. Verify that **Test plan** covers the risky paths and observable failure/recovery behavior, not only the happy path. Identify every important claim that remains untested.
6. Report each finding with severity, file and line, trigger, concrete impact, and the smallest safe mitigation. Do not suppress medium- or low-confidence risks; label uncertainty explicitly.
7. If you find no issue, state which risk areas you checked and any residual coverage gaps. Do not return a bare approval.

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
