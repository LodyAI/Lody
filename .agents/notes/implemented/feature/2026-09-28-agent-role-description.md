# Agent Role description metadata

Status: implemented
Translation: current

[中文](2026-09-28-agent-role-description.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1092

## Abstract

Roles previously had a name and execution prompt but no short invocation guidance.
An optional description now travels through the existing catalog and discovery
results, with a 140-code-point cap and localized editor hint. Legacy rows read as
blank, and description edits use the existing revision rules. The field does not
alter execution prompts or introduce a storage migration.

## Decision and evidence

The shared normalizer caps descriptions by Unicode code point so emoji are not
split. The editor applies the same cap while typing or pasting; form saves and
catalog reads enforce it too. Missing and empty descriptions compare equally,
avoiding needless revisions when older Roles are opened and saved.

Discovery exposes the description so agents can choose a Role by purpose. It
retains the visibility and target checks described in the
[catalog explanation](../../../docs/workspace-catalog-durability.md).
The separate [description Spec](../../../../specs/agent-role-description.md)
records the new intent; the existing
[mention availability decision](2026-09-09-agent-role-mention-availability.md)
continues to govern mentions.

Behavioral coverage extends the shared Role, form and resource-discovery suites
for legacy blanks, Unicode limits, edits, clearing, revision changes and discovery.
