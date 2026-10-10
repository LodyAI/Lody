# Keep context above a sent message

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1384

[中文](2026-10-10-sent-message-context.zh.md)

## Abstract

Sending a message previously placed it at the conversation's top, hiding the preceding
reply and making an ongoing conversation look like its first message. The scroll engine
now stops 100 px earlier so the preceding message's tail remains visible. Smooth and
reduced-motion sends use the same destination, and reply room shrinks by the same amount.
At the conversation start the scroll position clamps to zero; messages that cannot fit
below the context show their end instead. Desktop visual validation remains outstanding.

## Decision and ownership

This partially replaces the sent-message alignment in the
[scroll-engine decision](../architecture/2026-09-27-conversation-scroll-engine.md#write-forms).
Current intent is in the [conversation scroll Spec](../../../../specs/conversation-scroll.md).
The existing controller remains the sole scroll writer: its send glide, settled anchor,
reply-room calculation and available message height share the adjusted destination.
Adding physical top padding would hide the requested preceding content, so the change
reduces the scroll offset instead. The cost is 100 px less initial reply space.

## Verification and limits

The owning model suite checks the previous row's visible tail, reply growth and handoff
to following, smooth send completion, clamping near the start in both motion modes, and
messages too tall for the remaining space. All 70 engine model tests and 11 keyed-layout
tests passed using isolated Vitest 3.2.4 with unchanged source copies, without repository
setup or Vite plugins because the workspace has no installed dependencies. The simulator
uses explicit frames without real timers. Full workspace checks and desktop or iOS
visual verification were not performed.
