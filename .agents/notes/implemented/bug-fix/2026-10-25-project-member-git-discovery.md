# Non-Git member discovery at filesystem boundaries

Status: implemented
Translation: current

[中文](2026-10-25-project-member-git-discovery.zh.md)

## Abstract

Project member discovery recognized Git's parent-directory exhaustion message but
rejected its filesystem-boundary variant. This broke five CLI cases in
[PR #1877 CI](https://github.com/LodyAI/Lody/actions/runs/40192661157), including
local-copy resolution and non-Git member materialization. Accept both discovery
messages only with exit 128; other command failures continue to propagate.

## Decision and evidence

The [non-Git member contract](../../proposed/architecture/2026-10-16-multi-repo-projects.md#revision-non-git-members-and-multiple-roots)
requires a successful non-Git probe for an existing ordinary directory. Git emits
`not a git repository (or any parent up to mount point ...)` when discovery stops
at a mount boundary. The adapter previously recognized only
`not a git repository (or any of the parent directories)`.

Keep the existing native WorktreeGit owner and typed failure boundary. Recognize
only those two discovery messages; do not classify all exit-128 errors as non-Git
or change Git's filesystem discovery policy. Permission failures and an explicitly
broken `.git` path remain errors. No process lifecycle or migration boundary changes.

## Validation

The owning workspace suite injects both diagnostics and checks the resulting probe,
plus propagation of a different exit code, permissions and a broken `.git` path.
The filesystem-boundary case fails against the original source. Existing real-Git
workspace and Session tests cover the higher-level consumers.

The two previously failing suites and the Nowledge adapter suite pass all 66 tests
in a standalone clone with frozen-lockfile dependencies and prepared ACP adapters.
Full workspace types, lint, formatting, i18n and boundary checks pass. The full
`pnpm check` run reaches 4,655 CLI tests passed and 6,071 component tests passed,
but stops on one unrelated SSH fixture intercepted by the host session's Git shim
(`context_unreadable`). That same fixture passes with a native Git PATH and no
inherited GIT_EXEC_PATH/GIT_SSH overrides. Documentation checking in the authoring
checkout retains its 84 baseline errors with no additions.
