# ACP startup model selection

Status: draft
Translation: current

[中文](acp-startup-model.zh.md)

## Scenario

A conversation recorded with one Codex model resumes while the user's global Codex
configuration selects another. The driving Turn's selected model must reach native
session establishment, rather than being applied only after resume has warned.

## Contract

The host carries the driving Turn's `modelId` and configuration options through
new, load, resume, and fork using Core's `_meta.lody.sessionConfig` version 1.
A successful live selection becomes a later replacement's startup selection.
Prepared sessions are compatible only when their startup model also matches.

Codex translates the explicit `modelId` (or the `model` configuration option when
it is absent) before native establishment. Legacy `model[effort]` ids retain their
reasoning effort unless an explicit `reasoning_effort` option overrides it.
Omitted startup selection preserves native defaults; malformed supplied selection
fails before establishing the native thread. Native warnings remain visible when
an intentionally selected model differs from the recorded model.

This is additive metadata. Older adapters may ignore it; the host's existing live
configuration application remains necessary. The host and Codex adapter changes
must ship together to provide the startup guarantee.

## Evidence

The [decision note](../.agents/notes/implemented/bug-fix/2026-10-09-codex-resume-model.md)
records implementation and verification limits.
