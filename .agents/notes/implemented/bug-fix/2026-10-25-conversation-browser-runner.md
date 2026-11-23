# Pin the conversation browser runner to Ubuntu 24.04

Status: implemented
Translation: current

[中文](2026-10-25-conversation-browser-runner.zh.md)

## Abstract

The conversation browser job failed before running tests because `ubuntu-latest`
selected Ubuntu 26.04, which locked Playwright 1.58.2 cannot install Chromium on.
Pin only this job to Ubuntu 24.04, supported by its browser and native dependency
registries. Keep the existing dependency lock and browser tests unchanged; runner
upgrades require checking the locked Playwright platform support.

## Evidence and validation

[PR #1876 failure](https://github.com/LodyAI/Lody/actions/runs/40192373936/job/121165910613)
reports Ubuntu 26.04.1, a successful frozen dependency install, then an unsupported
platform error from `playwright install --with-deps chromium`. The test step never
ran. This is independent of the project's absolute-path UI change.

The workflow YAML parses, Ubuntu 24.04 Chromium download resolution succeeds in
Playwright's dry run, and 52 CI scope/test-planner tests pass. All 18 tests in the two conversation browser suites pass locally on macOS.
`pnpm format` passes; full `pnpm check` stops on missing local ACP submodules, and
docs check retains 31 links into uninitialized submodules. Local macOS execution
cannot verify Linux native package installation, which remains a hosted-run validation.
