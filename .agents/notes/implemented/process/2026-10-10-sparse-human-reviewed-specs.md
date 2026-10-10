# Reserve Specs for consequential human review

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[中文](2026-10-10-sparse-human-reviewed-specs.zh.md)

## Abstract

Broad instructions treated behavior changes as Spec triggers, creating a separate
query-retry Spec alongside an adequate README and Note. Specs now cover only
consequential decisions needing human review or explicitly requested specifications.
Existing owners take precedence; new Specs keep only the decision and essential
guarantees. Routine implementation behavior stays in owning docs.

## Decision

This narrows the Spec trigger preserved by the
[scoped-instructions decision](2026-09-08-scoped-agent-instructions.md), while retaining
[Note triggers](2026-09-07-explicit-agent-note-triggers.md), bilingual maintenance and
approval of each reviewed Spec revision. Root and finishing instructions now follow
the selection rules in `specs/AGENTS.md`; Notes no longer imply a companion Spec.

The query-recovery draft pair introduced in this PR is removed. Its implementation
details stay in the existing hook README and recovery Note, with inbound links repaired.
Existing unrelated Specs and product behavior are unchanged. Documentation checks and
formatting pass; application tests are not repeated for this documentation-only change.
These checks cannot establish whether future decisions meet the threshold.
