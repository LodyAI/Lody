# Recover main after the accidental Roost merge

Date: 2026-10-08
Status: implemented
Translation: current
PR: [#1323](https://github.com/LodyAI/Lody/pull/1323)

[中文](2026-10-08-accidental-roost-merge-recovery.zh.md)

## Abstract

An accidental merge introduced the Roost history implementation into main. Its
first-parent revert retained Roost and removed the already merged mention fix
instead, so the same history tests continued failing. This recovery restores the
mention fix, removes the accidental Roost changes, and preserves the subsequent
Daily journey repair. The source tree is verified against the pre-merge main tree
plus that repair; this is a source recovery, not a stored-data migration.

## Parent selection and recovery

Merge `d2aa65d0decc8a2f0bb885f28914b87133f238ec` has two parents:

- Parent 1, `4221bda0178cef160712416bbdeb8b124b667f8e`, contains the Roost feature.
- Parent 2, `eb761ddc820db943eda2f87e37cb8d48a4180668`, is the previous main and
  contains [the mention repair, #1317](https://github.com/LodyAI/Lody/pull/1317).

Revert `dc39c91f870a546ac3458dab394051294afe0db7` explicitly reversed the merge
against parent 1. Its tree equals that parent's tree, so Roost remained and the
mention repair disappeared. Recovery first reverses that incorrect revert, then
reverses the merge against parent 2. Both operations apply without conflicts on
main at `696fc4f2daa47526f57427175ca0bc1be1b330be`.

The resulting source tree is `97d671674d4f19e06e1b51f052ace4b670a71023`. Its binary
diff against parent 2 equals the exact six-file diff introduced by
[the Daily journey repair, #1318](https://github.com/LodyAI/Lody/pull/1318).
No reset or history rewrite is needed. Git still records the reverted feature in
ancestry; a future Roost integration must explicitly reintroduce its changes.

## Evidence and verification

- [Pre-merge main CI](https://github.com/LodyAI/Lody/actions/runs/37741828178)
  passed every job.
- [Incorrect-revert CLI tests](https://github.com/LodyAI/Lody/actions/runs/37745040263/job/113204399405)
  failed 30 tests across six files, including unavailable Roost backends and
  missing Linux credential-store support.
- [Incorrect-revert component tests](https://github.com/LodyAI/Lody/actions/runs/37745040263/job/113204399358)
  failed the initial-session assertion: expected `historyBackend: "loro"`,
  received `"roost"`.
- The merge, incorrect revert, and subsequent main commit show the same CLI
  failures. Existing behavioral suites cover the recovered history contracts;
  no new source behavior or test implementation is introduced.
- Local `pnpm check`, `pnpm format`, `pnpm format:check`, and document checking
  passed. The CLI suite passed 3,504 tests and the component suite passed 4,881;
  all seven suites containing the original failures passed. PR checks run after
  publication. Desktop packaging and browser/Electron journeys were not run locally.

The [Roost proposal](../../proposed/architecture/2026-09-30-roost-transition-delivery-lifecycle.md)
remains proposed. This recovery does not approve that architecture or claim that
any already running installation or Roost-created session has been migrated.
