# Keep Desktop Daily failure evidence in Actions artifacts

Status: implemented
Translation: current

English | [中文](2026-09-14-daily-failure-artifact-only-reporting.zh.md)

## Abstract

Desktop Daily failure reporting attempted to upload each WebM recording into the
owned failure Issue, but GitHub CLI rejects the workflow's GitHub App installation
token for media uploads. The reconciler now posts one idempotent text summary per
failed run and leaves recordings, traces, screenshots, logs, and runtime evidence
in the existing Actions artifact. This removes a long-lived user credential
requirement and the secondary reporting failure, at the cost of requiring
maintainers to open the Actions run to inspect evidence.

## Evidence

[Reporting run 34819857885](https://github.com/LodyAI/Lody/actions/runs/34819857885)
successfully reconciled [Issue 507](https://github.com/LodyAI/Lody/issues/507),
found and downloaded the canonical Daily artifact, and prepared its comments. It
then failed at `gh issue comment --attach` with `unsupported authentication type`.
GitHub Actions supplies a GitHub App installation token, while the GitHub CLI
attachment uploader accepts only OAuth tokens, classic personal access tokens,
and fine-grained personal access tokens.

[GitHub documents `GITHUB_TOKEN` as an installation access token](https://docs.github.com/en/actions/concepts/security/github_token),
while the
[GitHub CLI v2.100.0 uploader allowlist](https://github.com/cli/cli/blob/v2.100.0/internal/attachments/client.go#L71-L84)
excludes installation tokens.

Earlier runs did not prove this path: their canonical evidence had no indexed
recordings, so the same command posted a plain comment without exercising media
upload.

## Decision

The Daily reconciler keeps `actions: read` to discover the suite and canonical
artifact, `contents: read` to check out trusted reporting code, and `issues: write`
to own the failure Issue. It no longer downloads the artifact or installs a
separate GitHub CLI binary. For every failed run it posts a bot-owned summary
marker, commit, workflow-run link, and artifact name; a rerun finds that marker
and does not duplicate the comment.

The PR failure reporter is unchanged. This decision is limited to the shared
default-branch Daily failure Issue requested after the observed failure. It
retains the macOS-first canonical artifact selection described by the
[Desktop Daily platform bootstrap note](2026-09-08-desktop-daily-platform-bootstrap.md)
and changes only how that artifact is surfaced. Product behavior and E2E scenario
coverage do not change, so no Spec revision is required.

## Alternatives and trade-offs

A fine-grained personal access token could preserve inline video, but it would
introduce a durable user credential solely for diagnostic convenience. Keeping
evidence in Actions uses the existing short-lived workflow token and artifact
retention controls. Issue readers lose inline playback, but the text comment still
identifies the exact run and artifact.

## Verification

The policy tests cover artifact-present and artifact-unavailable summaries,
stable per-run markers, and the absence of user-attachment URLs. Workflow review
verifies that no Daily step downloads evidence or invokes GitHub CLI attachment
upload. A hosted `workflow_run` can only be exercised after the change reaches the
default branch and a later Daily run completes.
