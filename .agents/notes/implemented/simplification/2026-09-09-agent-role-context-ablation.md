# Agent Role context ablation

Status: implemented
Translation: pending

## Abstract

Opening plain chat to authorized machines left duplicate context branches and an
unused current-machine parameter. Sequential ablations removed those branches
and the parameter, including the caller memo dependencies, while retaining
local-project and worktree pinning. A negative control removed the disabled-item
insertion guard and caused the direct-selection regression test to fail, so that
guard was restored. This cleanup preserves the Role mention behavior rather than
changing its permissions or execution guarantees.

## Experiments

Follow-up to the [availability change](../feature/2026-09-09-agent-role-mention-availability.md)
in [PR #548](https://github.com/LodyAI/Lody/pull/548). Each positive experiment
kept the previous successful deletion; the negative control was restored before
final validation. Test fixtures changed only to remove the deleted argument,
with their behavioral assertions retained.

| Experiment | Result | Decision |
| --- | --- | --- |
| Baseline: six mention suites | 92 tests passed | Establish control |
| Remove provider/GitHub branch returning the default authorized scope | 25 Role tests passed | Delete: its result equals the following return |
| Remove GitHub no-worktree arm returning that same default | 25 Role tests passed | Delete: retain the original repo/worktree conditions for pinning |
| Remove unread `currentMachineId`, caller arguments and memo dependencies | 92 tests and component typecheck passed | Delete: all callers now derive context solely from the file source |
| Remove disabled-item guard in `onMentionAdd` | 1 failed, 20 passed; direct selection inserts a disabled Role | Restore: the guard protects observable behavior |

A separate before/after comparison of the actual context functions passed all
40 cases: ten source shapes (plain, local, provider combinations and GitHub
repo/worktree combinations), each with four current-machine inputs. This
checks context equivalence independently of the fixture argument edits.

Passing tests alone do not prove redundancy: the retained deletions also have
explicit equivalence or no-read evidence. Availability resolution, ordering,
hydration, expansion and private-Role visibility remain intact. No timing or
performance improvement is claimed; removing the memo dependency only avoids
recomputation triggered by an input the function does not read.

## Verification

`pnpm check`, `pnpm format`, and `pnpm run docs check` passed on the final
restored implementation. Components: 445 files / 3,318 tests passed. The note
documents experimental evidence; the existing Spec and binding rules retain
their meaning.
