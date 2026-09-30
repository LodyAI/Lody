# Separate Agent configuration output from launch data

Status: implemented
Translation: current

[简体中文](2026-09-30-agent-config-output.zh.md)

## Abstract

Inspecting an Agent configuration or merely renaming it with JSON output could
print all stored environment values. An explicit presentation contract now hides
all environment values by default, and mutations return receipts instead of launch
data. Deliberate inspection remains available with show-only `--show-secrets`.
Scripts consuming full configuration responses must migrate; storage and launch
behavior are unchanged, and the flag does not grant additional access.

## Decision

`commands/agent-config-output.ts` owns the allowlisted inspection projection shared
by human and JSON show. `envKeys` conveys presence without fake values that a
script could write back. The reveal flag adds only a copy of `env`, not arbitrary
runtime/auth/custom-launch fields. Create/update report the saved id and initialized/requested
field names. Assignment parsing reports positions instead of raw input.

A blacklist of sensitive variable names would miss arbitrary credential names.
Redacting in a generic JSON logger would miss human output and entangle unrelated
commands. Keeping the policy at the configuration presentation boundary leaves
persistence and launch data intact. Discovery list/get already have their own safe
summary contract and remain unchanged; this closes the remaining inspection and
mutation paths described alongside the [discovery decision](../feature/2026-09-27-resource-discovery.md).

The scope is stored environment values and implicit runtime field export. Values
intentionally put in display fields such as names, descriptions or prompts are not
automatically classified. Existing access checks, storage confidentiality, historical
output cleanup and credential rotation are outside this code change.

## Verification

Synthetic command tests exercise human/JSON show, explicit reveal, create from a
file plus inline values, rename-only and environment updates, preserved storage,
future-field exclusion and invalid input. Existing discovery tests cover list/get
projections. No live credential or production service is used. The [Spec](../../../../specs/resource-discovery.md)
remains draft; implementation is not approval or proof of deployment.
