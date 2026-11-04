# Composer and queued-message typography

Status: implemented
Translation: current

[中文](2026-11-02-composer-queue-typography.zh.md)

## Abstract

Queued messages used different text sizes depending on their presentation, while the composer run configuration had a heavier weight than adjacent context labels. Queue messages and their editor now use the same scalable body size and line height as the prompt, including pending and scheduled rows. Composer toolbar labels use regular weight; section headings retain their hierarchy. Browser and device appearance still needs verification in a complete checkout.

## Decision

Use the existing body tokens for the user's message in every queue state, and use the same line height for the leading gutter and action alignment. Context labels for machine, project, branch and worktree share the scalable subheadline size, line height and regular weight. Keep secondary labels smaller and headings medium-weight so hierarchy is conveyed without making peer controls unnecessarily bold. The shared toolbar trigger owns the configuration-label weight.
