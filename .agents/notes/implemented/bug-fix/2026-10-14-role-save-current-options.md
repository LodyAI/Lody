# Save current Agent Role options

Status: implemented
Translation: current

[中文](2026-10-14-role-save-current-options.zh.md)

## Abstract

Saving a Role retained retired option keys such as `thinking`, so the compatibility
warning survived repeated saves. Explicit Save now builds option values from the
selected agent's authoritative editor controls, preserving valid selections and
using current defaults for invalid or unset values. Opening the editor still keeps
the original draft. Unknown or provisional capabilities do not authorize removal,
and model and mode pins remain user choices.

## Decision

The form-to-row builder accepts the editor's current capability snapshot and
reconciles only at explicit Save. This uses the same model-specific controls as the
form, retains unrelated Role fields and leaves the old row untouched. Existing
content equality handles revision changes and repeat saves; catalog durability and
upload behavior stay unchanged.

This complements [automatic reconciliation](2026-09-11-agent-role-schema-reconciliation.md),
whose probe freshness and model-match requirements can legitimately defer cleanup.
Automatic maintenance keeps its stricter rules. Rewriting a draft on open would
hide the incompatibility before the owner chose to save. Current behavior is
documented in [catalog configuration](../../../docs/workspace-catalog-durability.md).

## Verification

The owning Role form suite covers retired-key removal, preserved selections and
memory/prompt fields, invalid option defaults, empty authoritative controls,
unknown/provisional capabilities, immutable input and idempotent resaving. This
checkout has no installed dependencies: Vitest and the TypeScript checker could
not start. No live desktop or user catalog was modified.
