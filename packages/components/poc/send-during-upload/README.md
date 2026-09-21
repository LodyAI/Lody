# Isolated send-during-upload POC

This experiment verifies a proposed upload-wait lifecycle against the real Session
composer. It is not imported by the application or included in its normal tests.
The production composer still blocks sending during uploads.

## Run

From the repository root, with workspace dependencies already available:

```sh
node packages/components/poc/send-during-upload/run.mjs
node packages/components/poc/send-during-upload/run.mjs --ablate
```

The runner creates a detached temporary worktree at the current `HEAD`, checks and
applies [prototype.patch](prototype.patch), runs the composer and routing suites,
and type-checks the component package. It removes its temporary worktree on normal
completion or a caught failure. Uncommitted application edits are not part of this
experiment. Dependencies are linked from this checkout; the runner performs no
installation and does not change package manifests or lockfiles. A missing
installation or a patch that no longer applies fails explicitly. A forcibly killed
runner may leave a `lody-upload-poc-*` temporary worktree for manual cleanup.

## Boundary

| Real implementation under test | Controlled test boundary |
| --- | --- |
| Session composer plus the experimental patch | Image upload promises and local-file handoff results |
| Existing submission token and focus lifecycle | Downstream acceptance promise |
| Existing Send / Steer / Queue route resolver | Updated parent callback supplying routing state |

The patch contains only the experimental composer change, the parent visibility
prop, and additions to the owning submission suite. The ordinary test suite and
production sources remain unchanged in the working checkout. No application entry,
feature flag, upload server, account, or daemon is started by this runner.

The positive run passes 82 cases (62 composer and 20 routing), including 28 POC
cases added to the existing 54 regressions, and component type checking. Coverage
includes file preparation/verification, partial failures, external draft replacement,
blocking session transitions, cancel/resubmit, A → B → A, and a scope change during
the commit that makes attachments ready.

`--ablate` first requires the positive run and type check to pass, then removes one
protection at a time and repeats both suites. Each variant restores its source in
`finally`. Collection errors and process failures do not count as caught regressions:
the named behavioral witness must fail with an assertion. The runner prints a JSON
summary with the actual failing test names. All 12 current variants are caught;
the [Agent Note](../../../../.agents/notes/proposed/feature/2026-09-21-composer-send-during-upload.md)
records the discoveries and the initially surviving variant that exposed a test gap.

Passing these checks establishes controlled frontend transitions, not end-to-end
provider delivery, real network failures, or real Electron interaction. Waiting is
memory-only; new-chat landing, restart recovery, and parent visibility integration
in a running application remain outside this experiment.

Proposed behavior: [Spec](../../../../specs/composer-send-during-upload.md).
Decision and results: [Agent Note](../../../../.agents/notes/proposed/feature/2026-09-21-composer-send-during-upload.md).
