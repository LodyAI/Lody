# Apply the selected Codex model before resume

Status: implemented
Translation: current

[中文](2026-10-09-codex-resume-model.zh.md)

## Abstract

Codex resumed with native configuration before Lody applied the driving Turn's model, producing model-mismatch warnings even when that Turn selected the recorded model. The host now carries the model through startup, and the adapter translates it before native establishment. Prepared-session matching also includes the model. Intentional model switches retain native warnings; live configuration remains necessary for older adapters and reused sessions.

## Decision

Core owns the additive version-1 startup metadata type. The host uses the driving Turn, not a history scan or a changed global default; confirmed live state supplies replacement startup. Codex gives explicit model selection precedence over a stale model option, preserves legacy effort suffixes, and lets explicit effort win. No warning filtering, global configuration edits, or rollout rewriting is needed. The [draft Spec](../../../../specs/acp-startup-model.md) defines the guarantee.

## Verification and limits

Host preparation and manager suites cover startup propagation and model-incompatible preparation cleanup. ACP v2 wire tests exercise new, resume, load replay, and fork through the real adapter and configuration projection, plus invalid startup rejection before native establishment. Adapter type checking and bundling pass.

A synthetic real-Codex 0.159.2 conversation recorded with one model was restored across process restarts. Without startup selection it resumed with a different configured model and emitted one mismatch warning; with startup selection it restored the recorded model and emitted zero mismatch warnings. The probe used temporary files, retained no transcript in the repository, and changed no user configuration.

The 55 adapter and 53 host tests pass, along with CLI/adapter/Core type checks, adapter builds, targeted formatting/lint, and the public-boundary check. Documentation checking is blocked by six pre-existing links into the uninitialized Kimi/Pi submodules; no changed-topic document error remains. Source changes do not update an installed desktop. Both changed public submodules must accompany the host change when integrated.

Companion PRs: [Core contract](https://github.com/LodyAI/acp-extension-core/pull/21) and [Codex adapter](https://github.com/LodyAI/acp-extension-codex/pull/66). The standalone adapter requires a Core release containing the new type before integration. Root `pnpm format` passes; full `pnpm check` stops at the documentation site because `fumadocs-mdx` is not installed in this checkout.
