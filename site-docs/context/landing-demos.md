# Landing scripted feature-tab demos

The onboarding indicator above the app preview
(`components/landing-feature-tabs.tsx`, `.underwater-tabs`) has 4 feature tabs
(worktrees / diff / design / mobile). The active tab's fill auto-advances on
`onAnimationEnd` (loops). Controlled by `components/underwater-experience.tsx`,
which passes per-tab `durations` and `paused` — demos run while the in-flow
stage is in view (IntersectionObserver) and pause when it leaves. The stage is
an ordinary page section under the hero. A light downward nudge on the hero
spring-scrolls to the stage; once there, free document scroll (no wheel-lock
tabs, rest pin, or CSS scroll-snap). The preview frame is `pointer-events: none`
so nested chat/scroll areas cannot trap wheel/touch — ghost demos still drive
the tree via `dispatchEvent`.

**Demos are scroll-decoupled.** They unlock once (first time the stage is
reached / intersects) and the `demo` prop stays non-null afterward — leaving
the stage must never set `demo={null}` (that tore down ghost scripts and
replayed them on every scroll past). Off-screen, feature-tab fill freezes via
`animation-play-state: paused` (no unmount) so auto-advance stops without a
restart when the user returns.

**Ghost pointer must not yank the page.** While any demo is active,
`scrollIntoView` is no-op'd and `HTMLElement.focus` is forced to
`preventScroll` (user wheel/touch still works). Clicks use synthetic
pointer/MouseEvent via `clickQuiet` — never `el.click()` (that focuses and
scrolls). When stage intersection &lt; ~55%, `ghostEnabled={false}` skips
clicks/drags entirely and hides the disc; state fallbacks may still idle.
Typing uses controlled state (`setPrompt` / `setReply`) via `scheduleTypedText`.

Each demo is a scripted "ghost user" (`.lody-demo-cursor`, portaled to `<body>`)
that drives the display-only replica (`components/landing-replica/`) via pointer
events on its DOM hooks, with direct state fallbacks so a loop never stalls. The indicator is an iPad-style
touch disc (CSS), not a desktop arrow cursor.

## Tab 1 — worktree (`demo="worktree"`)

- **Desktop shell (all viewports):** chat landing → worktree pill → type prompt
  (state only) → send → session streams reply. Panel stays closed. On compact
  viewports (`max-width: 1200px` or `max-height: 960px` — phone, tablet, and
  ~1000px laptops) the desktop shell is contain-scaled into the reveal frame
  (`.landing-desktop-demo-shell`) — it does NOT switch to the mobile session
  chrome. Roomy desktops keep a fluid shell
  at the fixed 1120×760 stage.
- **No phone focus camera:** Ken-Burns pan/zoom fought the ghost cursor on
  mobile and was removed. The shell stays at rest contain-scale; the cursor uses
  live element rects only.
- **Mobile tab only** owns the iPhone UI (see tab 4).

Budget `WORKTREE_DEMO_DURATION_MS`.

## Tab 2 — live diff (`demo="diff"`)

Boots on the GitHub clipping session with the right panel already open on Changes
(no toggle click). Widen handle → open first file → tiny skeleton → real diff.
Budget `DIFF_DEMO_DURATION_MS`.

## Tab 3 — design mode (`demo="design"`)

`lody` session → type "start landing dev server" → preview chip → annotate →
comment → hot-reload. Budget `DESIGN_DEMO_DURATION_MS`.

## Tab 4 — mobile (`demo="mobile"`)

iPhone frame at the same stage height as desktop demos (760, not taller) — the
replica's mobile home, new-chat sheet, and session, no full-width card chrome
flash → new chat → type jellyfish prompt → stream image. Budget `MOBILE_DEMO_DURATION_MS`.

## Post-demo scroll sections

Order under the product stage: **team collab** → **subscriptions (BYO
Claude Code / Codex / Grok / Kimi… + the ACP logo wall)** → **agent fan-out**
(short claim) → **CLI** (scripts/CI + terminal) → **power features** →
**mobile + Dynamic Island** → **closing CTA**. ACP marquee stays in
subscriptions only.

- Components: `landing-subscriptions-section.tsx` (providers + ACP wall),
  `landing-orchestration-section.tsx` (one agent runs others — minimal copy),
  `landing-cli-section.tsx` (terminal for people/scripts/systems),
  `landing-power-section.tsx` (team framing + live Stats/PR demos + short
  shared-session / private-machine points),
  `landing-mobile-deep-section.tsx` (Dynamic Island),
  `landing-cta-section.tsx`
- Keep screenshot fixtures and demo sequencing changes in this article so the
  public site has no dependency on private rollout plans.
- Dynamic Island: real iPhone still at `/landing/dynamic-island.png` — **not**
  simulated inside the feature-tab play stage. Optional short loop still open.
- Power grid: live usage and PR replicas (`landing-replica/power-usage.tsx`,
  `power-pr.tsx`) with deterministic mock data (`landing-power-demos.tsx`) — no
  static screenshots (theme mismatch).
  Diff / line-comment review is only in the feature-tab play stage.
