# Asynchronous Git execution for document maintenance

Status: implemented
Translation: current

English | [中文](2026-10-15-docs-async-git.zh.md)

PR: [LodyAI/Lody #1582](https://github.com/LodyAI/Lody/pull/1582) (draft).

## Abstract

Document status and checks failed in a restricted execution environment even when
Git returned the correct content and exit code 0: Node's synchronous pipe capture
also reported EPERM. The tool now awaits asynchronous Git execution throughout
status, check, diff, confirmation, and the CLI entry point. Binary output and
failure diagnostics remain intact, with exit code 1 accepted only for no-index
content comparison. Restricted-environment verification exercises the repaired
commands; the precise host/runtime cause of EPERM remains unidentified.

## Evidence and responsibility

This is a subprocess implementation fix to the
[document maintenance tooling](../../proposed/process/2026-09-05-human-reviewed-spec-maintenance.md),
not a change to Spec approval or SHA review policy.

In the same restricted Linux workspace on Node 24.22.0, `spawnSync('git', ['rev-parse', 'HEAD'])` with
pipe capture returned the correct HEAD, status 0, signal null, empty stderr, and
an error with code EPERM. `execFileSync` threw on that error. Synchronous runs with
ignored stdio or regular output files returned status 0 without an error, while
asynchronous `execFile` with pipe capture returned the correct bytes without an
error. This isolates the observed failure to the synchronous capture path; it
does not establish which underlying syscall or sandbox/runtime component causes it.
No permission policy was changed to make the script pass.

`scripts/docs/git.mjs` owns byte-preserving asynchronous execution and failure
classification. `main.mjs` awaits every dependent call, including topic inspection,
committed-inventory validation, temporary diff cleanup, base comparison, and
entry-point error handling. Per-topic errors still coexist with healthy topics.
A failure recovering a baseline blob includes the underlying Git diagnostic.

## Decision and trade-off

Use callback-based `execFile` behind a Promise, with Buffer encoding, the requested
cwd, and closed stdin. Preserve the existing 1 MiB per-stream capture limit;
exceeding it rejects rather than returning partial review data. Keep Node's
launch/exit/signal error and captured stdout/stderr. Only content comparison opts
into accepting exit code 1, and never when termination or capture failure occurs.

Ignoring EPERM whenever status is 0 would treat an incomplete capture as trustworthy.
Keeping synchronous execution with temporary output files would add filesystem
capture and cleanup to every Git call. Asynchronous execution avoids both choices
at the cost of making the imported report/command functions return Promises.
The owning suite and all callers are migrated together. This standalone Node tool
does not require an Effect dependency or an unrelated lifecycle migration.

## Verification and limits

The 29 tests in the documentation suites pass with real Git repositories, binary
blobs, unusual NUL-delimited paths, equal/different diffs, nonzero exits and stderr,
missing executables, permission denial, signal termination, and stdout/stderr overflow.
The CLI workflow covers confirmation, drift, read-only diff, reconfirmation, and
launch-error exit propagation. Synthetic executable fixtures use synchronous writes
to avoid a separate observed host limitation on nested Node socket-stdio writes;
CLI output uses regular files. Run the suite with
`node --test --test-isolation=none scripts/docs/*.test.mjs` on this host, whose
default test-runner child output is affected by that limitation.

Real `pnpm run docs status` succeeds under the original restrictions. `docs check`
runs and retains the baseline 82 broken links to absent submodule content and 68
warnings, with no registered SHA topics; these are not subprocess failures.
The error/warning lists before and after this task's documentation edits are identical.
Root `pnpm check` and `pnpm format` were attempted but stop at missing `tsgo` and
`oxfmt`. The scoped suite and formatting reuse the already available lock-matched
TypeScript 5.9.3 and Oxfmt 0.65.0 without installing or changing dependencies.
