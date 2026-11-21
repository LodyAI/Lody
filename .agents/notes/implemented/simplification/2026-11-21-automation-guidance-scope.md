# Limit Automation guidance to work beyond the current turn

Status: implemented
Translation: current

[中文](2026-11-21-automation-guidance-scope.zh.md)

## Abstract

Repeated recommendations in every Session prompt, MCP instructions, tool help and
the Automation skill made Automation look like the default for builds and tests.
The product owner reported excessive use and requested narrower guidance. Per-turn
prompts no longer recommend it; help and the skill reserve `run` for work that must
continue after the current turn ends and resume the Session on exit. The effect on
agent selection and cost has not been measured.

## Decision

Remove the per-prompt recommendation and leave MCP server instructions as a neutral
pointer to the skill. Ordinary commands, builds and tests stay in the current turn;
duration alone does not justify Automation. Conditions remain limited to future
behavior requested by the user.

This partially reverses the guidance in the [managed-run decision](../feature/2026-11-16-managed-long-runs.md).
That note retains process ownership, interruption and environment rationale.
Keeping the broad recommendation was rejected because it steers ordinary work into
additional continuation turns. Managed runs remain available: a command that must
outlive its turn still needs Host ownership to survive idle reclamation.

## Verification

The Session prompt suite exercises the generated prompt and optional PR-link guidance.
The MCP skill suite checks discovery manifests against served content and evaluates
the registration example. These checks do not establish agent selection frequency.
