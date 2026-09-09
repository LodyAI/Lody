# Require visual explanations for complex pull requests

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/520

[中文](2026-09-08-required-pr-visual-explanations.zh.md)

## Abstract

The pull request template now invokes `$show-me`, requires every author to address visual
explanation, and mechanically rejects large external changes that provide prose without a
structural view.

## Decision

Every pull request template now contains a required `## Visual explanation` section. Agents are
directed to invoke `$show-me` and use its smallest useful structural view. Simple changes may
instead provide a concise reason that a visual would not help review.

The scoped GitHub authoring rule applies that instruction to same-repository PRs as well. Their
bodies remain outside external-contribution policy enforcement, but the authoring Agent must still
follow the template and visual requirement.

A pull request is semantically complex when it crosses component, runtime, or authority
boundaries or changes multi-step control or data flow. The policy also defines an automatically
enforceable floor: changes above 200 added plus deleted lines must include a supported fenced
structural view, Markdown image, or linked HTML artifact. Reviewers remain responsible for
requiring a visual from smaller changes that are semantically complex.

## Enforcement

`check-pr-body.mjs` owns structural-view detection and accepts the changed-line count directly,
through `--changed-lines`, or from a pull-request event payload. `pr-policy.mjs` passes the current
GitHub additions and deletions into that validator. This keeps the body rule deterministic without
claiming that line count captures every form of complexity.

Supported fenced views follow the `$show-me` shapes: Mermaid, text trees or pseudocode, structural
diffs, and TS/JS component or code shapes. The checker also accepts Markdown images and reviewable
HTML links.
