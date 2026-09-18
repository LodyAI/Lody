# Represent file changes without line counts

Status: implemented
Date: 2026-09-18
Translation: current
[中文](2026-09-18-zero-line-diff-display.zh.md)

## Abstract

The assistant's edited-files card rendered `+0 -0` when Git reported a changed file without added or deleted text lines. The card now labels that entry as `Changed` while retaining the file and preserving ordinary line statistics. The generic label is deliberate because the persisted diff record cannot distinguish a permission-only change from binary content or an empty-file change.

## Evidence

The CLI derives turn file changes from `git diff --numstat --no-renames`. A minimal repository showed that an executable-bit change produces `0\t0\t<path>`, while binary content produces `-\t-\t<path>`; the current parser normalizes both forms to numeric zeroes. Removing zero-line entries would therefore hide real changes, and identifying them specifically as permission changes would claim information the stored `FileDiff` does not contain.

## Decision

`AssistantEditedFiles` treats an exact `add: 0, del: 0` pair as an uncounted change and displays a localized generic label. The same renderer is used for file rows and an all-zero summary, so neither surface presents zero additions and deletions as meaningful line statistics. Entries with positive additions or deletions and legacy entries with missing statistics keep their existing presentation.

## Verification

The component test renders an uncounted file beside a normal text diff and verifies both presentations. The Storybook story records permission-like, binary-like, and ordinary examples for visual review.
