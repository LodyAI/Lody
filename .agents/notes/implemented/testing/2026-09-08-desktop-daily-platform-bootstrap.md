# Desktop Daily platform bootstrap fixes

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/514

English | [中文](2026-09-08-desktop-daily-platform-bootstrap.zh.md)

## Abstract

The first scheduled three-platform Desktop Daily reported unrelated Windows and
Linux infrastructure failures as one generic Issue. Windows rejected generated
coverage solely because checkout line endings differed, while Linux removed the
Xvfb authorization path before launching Electron. Coverage checks now treat
CRLF and LF as the same generated content, and the isolated Electron environment
retains `XAUTHORITY`. This restores platform bootstrap without weakening registry
validation or broadening the process environment inherited by the application.

## Evidence

[Daily run 34197006995](https://github.com/LodyAI/Lody/actions/runs/34197006995)
on commit `a07eeba2bf97faa40ba501000ab9c3296dc4a031` was the first scheduled run after
[PR 459](https://github.com/LodyAI/Lody/pull/459) added Linux and Windows to the
matrix. macOS passed. Windows stopped in the suite contract because its CRLF
checkout did not equal the LF-only string returned by `renderCoverage()`. The
registry and generated Markdown were otherwise identical.

All four Linux scenarios failed before opening a window. Electron logged
`Authorization required, but no authorization protocol specified` followed by an
X11 platform initialization failure. `xvfb-run` supplied `DISPLAY` and a temporary
`XAUTHORITY`, but [`createIsolatedEnvironment()`](../../../../e2e/src/support/electron-harness.ts)
retained only the former. The Linux artifact contains a four-row
`failure-index.json`, so the failures share the same launch boundary rather than
four product assertions.

## Decision

[`coverageMatchesRegistry()`](../../../../e2e/scripts/journey-registry.mjs)
normalizes CRLF to LF before comparing generated coverage. It still rejects every
other content difference, including added text, missing rows, and whitespace not
caused by Windows line endings. Both the suite checker and the standalone coverage
checker use this contract.

The Electron harness adds only `XAUTHORITY` to its inherited environment allowlist.
Passing the entire runner environment would expose unrelated CI variables to the
application process and its descendants. Keeping the allowlist preserves the
isolation boundary while allowing Electron to authenticate to the X server named
by `DISPLAY`.

## Reporting limit

[Issue 507](https://github.com/LodyAI/Lody/issues/507) says that zero scenarios
were indexed because the Daily reconciler deliberately selected the successful
macOS artifact as canonical evidence. The failed Linux artifact did contain all
four scenario IDs. This change fixes the platform failures; it does not change the
reconciler's macOS-first reporting policy introduced by PR 459. Per-platform
failure aggregation remains separate work.

## Verification

Unit coverage proves that CRLF generated output matches while changed content
does not, and that `DISPLAY` plus `XAUTHORITY` cross the Electron allowlist while
an unrelated variable does not. Local macOS verification cannot reproduce a
GitHub-hosted Xvfb session, so a Linux Actions run remains the end-to-end proof.
