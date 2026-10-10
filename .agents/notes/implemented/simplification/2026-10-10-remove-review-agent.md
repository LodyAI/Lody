# Remove the Review agent experiment

Status: implemented
Translation: current

[中文](2026-10-10-remove-review-agent.zh.md)

## Abstract

Review agent exposed per-session review and automatic merge through an experimental
opt-in, while its daemon loop continued after the UI gate was disabled. Removing
only the switch would leave hidden automation running or make it generally available.
The removal therefore covers the UI, daemon loop, reviewer MCP tool, and shared
review policy/run implementation. Historical data remains intact; its legacy pointer
is inert, and manual PR actions continue to use shared prompts.

The intended behavior is in the [retirement draft](../../../../specs/review-agent-retirement.md).
The fleet no longer assembles a review scheduler or credential resolver. Session menus,
Provider settings, experiment preferences, translations, and stories lose their review
surfaces. The deleted engine tests cover removed behavior; the structural gate test is
also removed. The MCP catalog and session-menu suites cover the absent entry points,
and Edit & Resend exercises a real history replacement with legacy metadata retained.

Manual PR/commit prompts previously shared `review-prompts.ts` with automation.
They move to `pr-prompts.ts` without changing their exported values. Legacy review
Flock rows and session pointers are not rewritten or erased; older daemons are outside
the updated runtime's guarantee. Already executing reviewer turns remain ordinary
agent work, so retirement is not a cancellation protocol.

## Verification

The targeted CLI suites pass 61 tests and the UI suites pass 28 tests, including
manual PR prompts and the remaining Roost toggle. Shared and components type
checks, lint, translation-key checks, public/platform/process/Code Collab boundary
checks, formatting, and documentation checks pass. Documentation reports existing
maintenance warnings and no registered SHA topics. Full root type checks and lint pass. The root check encountered a 30-second
timeout in `apps/cli/tests/roost-session-backend-contract.test.ts` (signed-prefix
reuse/restore and old-writer fencing); a single-test re-run also timed out. That
Roost test and its history backend are unchanged by this removal, but no baseline
comparison was executed. The full run was stopped after reproducing that failure and cannot be reported
as passing. No deployed or visual acceptance is claimed.
