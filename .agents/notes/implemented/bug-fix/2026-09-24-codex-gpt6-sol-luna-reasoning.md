# Restore GPT-6 Sol and Luna reasoning options

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/955

[中文](2026-09-24-codex-gpt6-sol-luna-reasoning.zh.md)

## Abstract

The built-in Codex selector removed Max and Ultra from GPT-6 Sol and Luna because its exact-model support table omitted both new IDs. Add Sol with Max/Ultra and Luna with Max only. This restores the existing model-specific selector contract without granting unsupported efforts to unknown models. Future models still require explicit table maintenance.

## Decision and evidence

The normalizer both supplies missing extended options and filters cached options, so merely updating the runtime catalog cannot fix the UI. PR [#406](https://github.com/LodyAI/Lody/pull/406) introduced the current per-model table; [#286](https://github.com/LodyAI/Lody/pull/286) retained that path for built-in Codex when adding generic per-model effort maps. This change extends that existing policy rather than changing capability authority or assuming every new model supports Ultra.

The existing selector suite now covers Sol option synthesis and advertised metadata preservation, plus both Luna versions with Medium, Max, and Ultra cached selections. Luna retains Max and falls back to Medium for unsupported Ultra. The source guidelines name both model generations explicitly.

## Verification limits

The worktree has no installed dependencies; full package tests and repository checks require a prepared workspace. Documentation checks also report pre-existing links into uninitialized ACP submodules. See the PR test plan for executed checks and their results.
