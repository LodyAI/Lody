# Desktop handoff startup admission

Status: implemented
Translation: current

[中文](2026-10-28-desktop-handoff-startup-admission.zh.md)

## Abstract

A desktop channel can own the process-exclusion lease before it finishes Host
admission and application import. The previous handoff path let that partial owner
acknowledge a deep link into an unconsumed startup buffer, so a launch that then
showed a Host-conflict dialog exited without opening the link. Handoff acceptance is
now tied to the launch handler being bound: pending links wait for normal slow
startup, a refused startup rejects them explicitly, and the owner and client use
separate bounded waits. The change is covered by deterministic startup, lease and
admission tests; packaged cross-channel launch validation remains outstanding.

## Problem and decision

The desktop lease and the ability to consume a launch have different lifetimes.
`desktop-exclusion.ts` owns the port, while `index.ts` can still reject startup after
Host inspection or fail during the lazy application import. Acknowledging a handoff
when the lease is acquired therefore proves only port ownership, not delivery.

`desktop-launch-admission.ts` separates those concerns with one first-decision
promise. A link is accepted only after `index.ts` has bound the existing launch buffer
to `application.handleDesktopLaunch`. A startup that refuses Host admission, fails
application import, or exits through the top-level startup failure marks admission
rejected for that process lifetime; pending and later handoffs receive an explicit
negative response. Once ready, delivery enters the existing buffer and parser without
a second routing path. Concurrent waiting handoffs are delivered in arrival order
after admission; a later ready fast path does not overtake them.

The owner waits up to five seconds for admission before replying. The sending client
waits six seconds, so it observes the owner refusal rather than racing it. A link
whose admission outlives the owner deadline is still delivered if that admission
later succeeds; the sender may already have shown the conflict, but neither a false
success nor a permanently cached acceptance is created. Socket read timeout remains
separate from admission: the request line is read promptly, then admission owns the
next deadline.

Authentication and other cloud callbacks remain outside this handoff, Host
exclusivity is unchanged, and the losing process still loads no credentials or
business modules.

## Alternatives

Acknowledging immediately after Host admission would avoid most false positives but
would still acknowledge a link if the lazy application import failed. Waiting for
renderer navigation before acknowledging would hold the sender far beyond what
delivery ownership requires. Removing the buffer would duplicate the existing launch
path and lose early callback compatibility.

## Evidence and limits

`desktop-exclusion.test.mjs` covers asynchronous admission, rejection, and the
pending admission state; `desktop-startup.test.mjs` covers a Host-conflicted startup
that rejects handoffs before and after the competing daemon stops, a fresh owner that
accepts after recovery, normal handoff, auth isolation, and existing Host ownership.
The startup fixture uses resolved promises rather than sleeps. Packaged installation,
real OS dispatch, and cross-version behavior remain release acceptance; the current
protocol bounds are source-level behavior.

Related: [desktop channel identity](../../proposed/architecture/2026-09-23-desktop-channel-identity.md),
[desktop channel execution](../../../../specs/desktop-channel-execution.md), and
[deep links](../../../../specs/deep-links.md).
