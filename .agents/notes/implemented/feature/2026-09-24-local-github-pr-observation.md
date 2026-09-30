# Local credentials for PR observation

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/958

[中文](2026-09-24-local-github-pr-observation.zh.md)

## Abstract

Local sessions could display branches but their PR discovery was still gated by
product-cloud repository registration and the hosted association port. Repository
identity now comes from Git, while authenticated GitHub reads determine access.
The existing machine reconciler runs in local mode with ambient gh credentials
and no cloud association. This provides PR/CI summaries without exposing credentials
to the renderer; detailed review and mutation remain hosted capabilities.

## Decision and limits

Reuse the fleet reconciler instead of adding renderer polling or inventing a
local CloudPort. Association remains mandatory for hosted workspaces, where it
powers webhook delivery, and is explicitly absent locally. A one-minute credential
cache retries absent/login states and observes rotation. GitHub installation tokens
may successfully query PRs while `/user` fails; use a conservative shared quota
scope instead of treating user-profile access as repository authorization.

New local sessions retain the remote-derived repository without a cloud registry
lookup. WorkspaceGitService, renamed from the branch-only owner, also fills missing
identity on authorized root activation/refresh. It preserves configured identity,
serializes observation, and publishes the branch before making a missing repository
eligible for discovery. Ordinary file refreshes do not add Git probes. Existing
sessions become eligible when opened/refreshed rather than through a global scan.

Local PR links open GitHub externally because local summary access does not enable
cloud-token detail hooks. Authentication and repository cooldowns still apply;
login is not an immediate-refresh guarantee. No remote means no discoverable PR.

## Verification

The focused CLI suites cover local discovery without association, hosted association
failure, Git workspace backfill, login/rotation/logout, credential quotas and Git
refresh triggers. A read-only live query confirmed PR access with a local credential
whose `/user` request was denied. `pnpm check`, `pnpm format`, and `pnpm run docs check` passed; native desktop click-through was not performed.

Contract: [Spec](../../../../specs/local-github-pr-observation.md).
Branch behavior: [earlier decision](../bug-fix/2026-09-24-workspace-branch-observation.md).
