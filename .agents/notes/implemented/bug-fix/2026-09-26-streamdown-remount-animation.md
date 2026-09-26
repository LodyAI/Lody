# Keep existing streaming text visible across session switches

Status: implemented
Translation: current

[中文](2026-09-26-streamdown-remount-animation.zh.md)

## Abstract

Switching back to a Session with an active response remounts its Markdown rows.
`@lobehub/streamdown` treated the text already in those rows as newly generated
and replayed its initial fade. The renderer now asks a small dependency patch to
show mount-time text immediately while continuing to animate later additions.
The patch is version-specific and should be removed when upstream offers this
behavior.

## Problem and decision

The [Streamdown integration](../feature/2026-09-26-lobehub-streamdown.md) sends
unfinished turns through the stream engine. A Session switch or Virtua remount
creates a fresh engine instance even though the message already has content.
Its first render assigns new animation birth times to the existing tail.

The renderer passes `animateOnMount={false}`. The patch to
`@lobehub/streamdown@1.4.0` marks complete blocks as settled on the first render
and seeds the open tail's rendered characters as already revealed. It counts
rendered characters in the existing rehype pass, so Markdown syntax characters
do not shift the boundary. Subsequent additions receive normal birth times and
retain smoothing and fading. The default prop remains `true` for other callers.

## Trade-off and verification

The first content seen by a newly mounted streaming row appears at once; animation
begins with later content. A patch adds upkeep when upgrading Streamdown, but keeps
the correction at the point that owns character birth times. Keeping the React
tree mounted across Session switches would also avoid replay, at a higher memory
and rendering cost.

The Markdown renderer test covers immediate initial text and a later animated
addition. A frozen lockfile install confirms the package patch applies. Visual
verification in a running desktop app remains open.
