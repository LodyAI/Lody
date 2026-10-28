# Bound Markdown copy feedback to its mounted link

Status: implemented
Translation: current

[中文](2026-10-26-markdown-copy-feedback-lifetime.zh.md)

## Abstract

Copying a Markdown file path started a feedback timer that survived link disposal.
Its later React state update could run after the browser test environment closed.
The mounted link now owns that timer through an effect cleanup; the existing
1,200 ms feedback remains. Clipboard delivery and file-opening behavior are unchanged.

## Ownership and evidence

`AgentFileLink` in `markdown-renderer.tsx` owns both the copied indicator and its
reset. A global callback lifetime is unnecessary: once the link disappears there
is no indicator to reset. This follows the [lifecycle containment contract](../../../docs/failure-containment.md).

The existing `markdown-agent-file-chip` suite renders the real link, copies a
synthetic path, advances a fake clock to observe feedback reset, then copies again
and unmounts. Before the fix, one timer remains; afterwards no timer remains.
The focused Markdown and session-file suites pass. This establishes UI timer
cleanup, not native clipboard integration. The issue surfaced while validating
[security PR #1891](https://github.com/LodyAI/Lody/pull/1891) and is separate from its dependency patches.
