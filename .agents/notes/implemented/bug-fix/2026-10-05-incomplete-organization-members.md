# Incomplete organization membership responses

Status: implemented
Translation: current

[中文](2026-10-05-incomplete-organization-members.zh.md)

## Abstract

A non-null active organization without `members` crashed the cloud provider while
deriving the current user's role. Treat this incomplete response as unavailable
and expose an error through the existing refetch path, with no admin permissions.
Sharing controls also treat missing membership as unknown. The upstream cause of
the incomplete response is not established; Better Auth 1.6.33 still returns a
member array for a normal full-organization response.

## Behavior and evidence

This supplements the [1.6 upgrade baseline](2026-09-30-better-auth-1-6.md).
Do not replace missing membership with an empty roster: that would claim a complete
response and lose the distinction between unknown membership and a solo workspace.
Do not repeatedly activate the same malformed organization. Explicit navigation to
a different organization must still activate that target, and an old target's data
error must not be attributed to the new one.

Hook tests cover missing/null membership after an owner response, fail-closed
permissions, recovery after refetch, navigation away from an incomplete organization,
and sharing visibility before and after membership arrives. These synthetic
regressions reproduce the client crash but do not identify the original wire payload.

## Ablation evidence

The four-suite baseline and final simplification each pass 32 tests. Removing one
protection at a time produces these failures; each experiment restores the original
source before the next deletion:

| Removed protection | Result |
| --- | --- |
| Full-membership gate on the resolved organization | 2 failures: `members.find` crashes for undefined/null |
| Target scoping of the membership error | 1 failure: the previous organization's error reaches the new target |
| Same-target activation guard | 2 failures: an incomplete organization is activated again |
| Sharing membership array guard | 2 failures: `members.length` crashes for undefined/null |

Keep these protections. Reuse the existing target-match boolean for error scoping,
and collapse the null-or-different-ID condition to an optional-chain comparison:
the target comes from an organization list entry with a required string ID. These
changes remove duplicate expressions without removing a behavior boundary.
Reproduce with `NODE_ENV=test pnpm --filter @lody/components exec vitest run
tests/useOrganization.test.tsx tests/use-session-sharing.test.tsx
tests/cloud-platform-provider.test.tsx tests/workspace-route-guard.test.ts`.
This experiment does not assess dependency patches or native login.
