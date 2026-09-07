# Explicit Agent Note triggers

Status: implemented
Translation: current

English | [中文](2026-09-07-explicit-agent-note-triggers.zh.md)

## Abstract

An indirect instruction to record important trade-offs leaves room to omit design-only
conclusions. The root instructions now require Agent Notes for non-trivial work and
link to explicit triggers and exemptions. Existing owning notes should be updated;
new decisions receive linked records. This clarifies contributor obligations but
does not add an automated check that judges whether a change is non-trivial.

## Decision and scope

The [note rules](../../AGENTS.md#when-to-write) own the trigger definitions, including
research/design conclusions and tasks that explicitly forbid file writes. The root
instructions expose the requirement directly; the finishing workflow applies it to
both code diffs and design conclusions. Proposals remain proposals until adopted
and implemented. Public notes contain public rationale, not private transcripts.

This refines the note-writing threshold in the earlier
[maintenance proposal](../../proposed/process/2026-09-05-human-reviewed-spec-maintenance.md).
Its translation, Spec approval, and historical-retention policies are unchanged.
The root's directory inventory now links to the README repository map to make room
without removing binding product rules or increasing the size limit.

## Alternatives and consequences

- Keep the indirect, importance-based trigger: less explicit wording, but research
  conclusions can be omitted because no code changed. Explicit triggers are easier
  to apply and review, at the cost of more records for substantive small changes.
- Require a new note for every edit: mechanically simple, but duplicates existing
  decisions and burdens typo or formatting fixes. Updating an owner suffices, and
  mechanical/local edits without changed decisions remain exempt.
- Copy another project's entire documentation policy: would also change archive,
  translation, and validation rules. This change adopts only the explicit trigger
  structure and preserves the existing Lody policies.

## Verification limits

Document checks cover links, metadata, and instruction sizes, not semantic compliance
with the note-writing obligation. This is a documentation-only change; it establishes
no product-performance result and does not approve the earlier maintenance proposal.
