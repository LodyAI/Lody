# Remove share task proposals and retain publication credentials

Status: implemented
Translation: current

[中文](2026-09-13-share-proposal-and-credential-boundaries.zh.md)

## Abstract

Authenticated share previews inherited workspace task actions, while closing a
dialog during the final publish request could discard its only reader credential.
Capture now excludes task-proposal display blocks and readers reject them. New
publication saves and verifies its reader credential before upload and commit,
so server completion no longer depends on a mounted dialog. Storage failure
stops publication rather than silently relying on temporary component state.

The [static sharing design](../../proposed/architecture/2026-09-12-static-session-sharing.md)
otherwise remains unchanged. Only `system_notice/task_proposal` is excluded;
subagent records, text, and opaque tool payloads remain reference data. Projection
and read validation share one display-container traversal. Original history is
never edited. Previously published packages containing proposals require a fresh
deployment to be readable; this unreleased cutover has no compatibility path.

Pending state retains the complete begin response for retries. Storage must report
`stored` and read back the same secret; newer credential versions cannot be
overwritten. Lifetime checks stop work after closure before commit. Once commit
starts, its late success needs no further credential write. Disabling dialog
dismissal alone was rejected because reload and navigation can still unmount it.
Upload credentials and existing reset-link behavior are unchanged.

Deterministic tests cover source preservation, proposal exclusion before attachment
reads, nested proposal rejection, subagent/tool retention, close-during-commit
recovery, storage failure/retry, and newer credential protection. They do not
establish hosted deployment acceptance. PR: [#646](https://github.com/LodyAI/Lody/pull/646).
