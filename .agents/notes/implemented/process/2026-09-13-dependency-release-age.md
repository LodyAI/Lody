# Dependency release-age quarantine

Status: implemented
Translation: current
Chinese: [2026-09-13-dependency-release-age.zh.md](2026-09-13-dependency-release-age.zh.md)
PR: https://github.com/LodyAI/Lody/pull/629

## Abstract

Dependency resolution previously allowed versions immediately after publication,
so compatibility upgrades could consume releases before the ecosystem had time
to identify compromised or defective artifacts. The pnpm workspace now applies
a seven-day minimum release age to newly resolved package versions. Existing
locked versions remain the reviewed baseline, while future lockfile updates select
only versions that have completed the quarantine period.

## Pressure

The Vite 8 compatibility stack exposed that functional CI and end-to-end coverage
do not provide a publication-age safeguard. Vite 8.3.0 entered the upgrade branch
less than two days after publication because the workspace had no resolver-level
delay. A repository-wide setting is preferable to relying on each dependency
upgrade author to calculate release dates manually.

## Decision

Set pnpm `minimumReleaseAge` to `10080` minutes in `pnpm-workspace.yaml`. This is
seven complete days and applies uniformly whenever pnpm resolves a version for
the root workspace. The three Loro Mirror 2.3.2 packages already locked on the
trunk are grandfathered with exact-version exclusions so enabling the policy does
not retroactively invalidate the accepted lockfile. The exclusions do not apply
to later Loro releases; any broader exception requires a separate, explicit
decision with evidence proportionate to the supply-chain risk.

The policy controls future resolution, not the historical publication age of
entries already accepted into the lockfile. The active compatibility stack
therefore uses Vite 8.2.2, the newest stable Vite 8 release that had completed
the seven-day quarantine when this decision was implemented, rather than
retaining the younger Vite 8.3.0 lock entry.

## Verification

The workspace setting is read by the repository-pinned pnpm 10.20.0. A frozen
lockfile install verifies that enabling the policy preserves the reviewed
baseline, and dependency resolution on the Vite upgrade branch verifies the
eligible Vite 8 selection. The exact Loro exclusions match only the versions
already present on the trunk.
Normal static, build, test, and full desktop end-to-end checks remain responsible
for compatibility; release age is an additional supply-chain gate, not a substitute.
