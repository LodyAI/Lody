# Prepared Session surfaces for desktop windows

Status: proposed
Translation: current

[中文](2026-09-23-prepared-session-surfaces.zh.md)

## Abstract

A warm shell still pays for target history and rendering after the user opens a
window. Propose preparing bounded, target-specific interactive surfaces before
the request, then presenting an existing surface. A longer-term shared data owner
could remove repeated document import across renderers; macOS GPU surfaces offer
a separate visual-preview option. A macOS-only benchmark prototype now presents a prepared real Session in about
41 ms median, with text insertion confirmed in 90 ms. The first stage is now integrated into the opt-in macOS local warmup path;
shared data ownership and GPU previews remain proposals. Cache misses and independent
duplicate views are explicit limits.

## Evidence and constraints

The [current fix](../../implemented/bug-fix/2026-09-22-warm-window-content-readiness.md)
and [benchmark](../../../../packages/components/benchmarks/window-bootstrap/README.md)
measured 430.77 ms median for 3,000 entries and 256.56 ms for 100 entries after
cold-document adoption and layout preloading. The five large-history samples'
native show-call-to-show-event intervals were 30.99, 31.42, 54.97, 38.05 and
31.55 ms; matching readiness reached show in approximately 0.2 ms. These intervals
come from the instrumented probe, not a measurement of pixels reaching the display.
Most measured time is still before native presentation.

The [window Spec](../../../../specs/desktop-windows.md) preserves the source window
when opening a new one. Moving its sole live view would violate this behavior.
The provider rules now allow only the main-owned macOS prepared-window lifecycle
to mount a speculative Session, under the draft window contract. Raw-snapshot
background prefetch remains separate and cannot acquire Session UI stores.

## Proposed sequence

1. **Target-specific prepared surface (integrated).** Use one hidden target-bound window,
   using the existing native host. Prepare from high-confidence intent (opening a
   Session context menu or row hover/focus). The current single slot has expiry and
   cancellation, but no recent-target cache.
   Finish real hydration, layout and scroll restoration before marking it ready.
   A matching claim shows that exact renderer without navigation or remounting.
   Mouse-down alone is insufficient preparation lead time. Misses retain the
   current correct opening path; report hit rate rather than excluding misses.
2. **Separate view and window lifetime.** Consider BaseWindow/WebContentsView only
   after the first experiment establishes benefit. A view can retain its renderer
   state while attached to a native host. A source-preserving duplicate still needs
   a separate view, prepared in advance. Reparenting is useful for an explicitly
   different detach/move action; seamless retained compositor output needs testing.
3. **Shared data ownership.** Evaluate an app-lifetime utility process or the
   existing daemon as the sole desktop document/projection owner. Views subscribe
   to bounded, revisioned history projections and updates rather than importing a
   whole CRDT replica. Independent drafts, selection, scroll and navigation remain
   view-local. Commands go to the actual owner; do not add a second optimistic
   writer or preserve independent replicas with shared cursors. This replaces the
   current runtime contract, so migration, durable write acknowledgement, reconnect
   generations and owner crash recovery must be designed together.
4. **Optional macOS visual bridge.** Offscreen shared textures expose IOSurface on
   Electron 39.5.1. A native addon could copy an already rendered target frame into
   an app-owned GPU texture and present it through an AppKit/Metal host while an
   independent live view prepares. This accelerates visible content only; the frame
   is not an independently interactive document. Full OSR interaction requires
   input, IME, accessibility, popup and focus integration. Do not equate preview
   visibility with input readiness or queue speculative destructive clicks.

A proposed warm-hit target is input-to-content and input-to-working-composer P95
under 100 ms on the reference Mac. This is an acceptance target, not a prediction
or a universal perceptual threshold. Record native event timing separately from
on-screen frame evidence. Measure cold misses, zero-lead requests, streaming,
deleted targets, repeated claims, cancellation, resize, Retina/external displays,
Spaces/fullscreen, source close, crash recovery, RSS and idle CPU. Match readiness
by workspace, Session, preparation generation and viewport configuration. Recheck
target validity and keep cache eviction/resource lifetimes explicit. Speculative
views must not mark read, send notifications, autofocus or mutate shared state.

## Native feasibility and alternatives

[Electron 39.5.1 WebContentsView](https://github.com/electron/electron/blob/v39.5.1/docs/api/web-contents-view.md)
supports an existing WebContents, but one WebContents can be presented in only one
WebContentsView. [BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)
does not automatically destroy attached WebContents when closed; ownership must
be explicit.

[utilityProcess](https://github.com/electron/electron/blob/v39.5.1/docs/api/utility-process.md)
provides a Node process and message ports, not automatic sharing of JS/WASM objects.
[OSR](https://github.com/electron/electron/blob/v39.5.1/docs/tutorial/offscreen-rendering.md)
provides GPU output without CPU bitmap readback.
[The native texture guide](https://github.com/electron/electron/blob/v39.5.1/shell/browser/osr/README.md)
warns that frames use a limited recyclable pool: copy to an owned texture and release
promptly. The macOS handle is process-local; a raw pointer is not a cross-process
transport. Layout size, scale and content revision determine preview validity.

[NSWindow.animationBehavior](https://developer.apple.com/documentation/appkit/nswindow/animationbehavior-swift.property)
can disable automatic ordering animations, but cannot eliminate React rendering or
document preparation. No animation-only speedup has been measured. Rewriting the
conversation in AppKit would still need data and layout, with substantial feature
parity work; it is not required for the first experiment.

## macOS prototype evidence

The [reproducible probe](../../../../packages/components/benchmarks/window-bootstrap/README.md#macos-prepared-content-prototype)
now holds the actual target window hidden after normal readiness, then presents it
on a separate probe-only IPC. A temporary N-API/Objective-C++ addon uses the native
NSView handle to disable NSWindow ordering animation through public AppKit APIs.
It does not ship in the app, alter packaged dependencies, or change production IPC.

With unique-token input validation, ten prepared/native samples measured 40.76 ms
median from presentation IPC to native show (32.85–75.72 ms), and 90.15 ms to text
insertion observed after an animation frame (80.73–144.70 ms). Three discarded
warmups also passed. The current path measured 443.82 ms show and 490.78 ms input
confirmation in five samples. A five-sample prepared run without native animation
changes measured 38.31 ms show and 84.64 ms input; all 29 final checks across the
three variants passed, including warmups. Preparation still costs 409.11 ms median before the
request; the fixture deliberately has 100% target hits. This validates a possible
presentation path, not a prediction algorithm or shipped instant-open behavior.

An exploratory five-sample native run measured 22.43 ms show, but the longer
repetition did not sustain that median. An earlier repetition stopped on a
repeated-token input assertion; its cause was not established. The revised probe
requires a unique absent token and retention after a frame, avoiding false passes
from existing drafts. No insertion retries mask failures. Native text insertion
is not physical keyboard/IME acceptance. Tail input latency still exceeds the
proposed 100 ms target; native animation removal alone has no established stable
benefit. Production lifecycle and side-effect validation are recorded in the
   [implementation note](../../implemented/bug-fix/2026-09-22-warm-window-content-readiness.md).
Real-world target hit rates, memory budgets and signed native distribution remain
unverified; the native addon is still probe-only.

## Outcome

Prefer a target-bound, fully interactive warm surface experiment first. Treat
shared ownership as a separate architecture migration and GPU previews as an
optional visual mechanism. The probe-only native addon changes no product behavior. The first-stage integration
uses existing native BrowserWindows and the draft Spec; its implementation evidence
lives in the linked note. Documentation
checks retain the checkout's existing absent-submodule link failures, and root checks
stop at missing packages/ignore dependencies. The macOS arm64 addon compiles and runs
in the isolated probe; packaged native distribution has not been validated.
