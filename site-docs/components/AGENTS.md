# site-docs/components

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `site-docs/AGENTS.md` also apply; the marketing-shell rules
for pricing / download / changelog live in `site-docs/AGENTS.md`.
File-by-file ownership and the visual-tuning shortcut are in
[`site-docs/README.md`](../README.md); palette detail, cost measurements, history,
and the replicated session shell's current shape are in
[landing and marketing internals](../../.agents/docs/site-landing-and-marketing.md).
Demo sequencing and screenshot notes live in
[context/landing-demos.md](../context/landing-demos.md).

## Marketing landing

- The landing (`/`, `/home`, `/zh`, `/zh/home`) is an immersive WebGL "underwater
  point-cloud" hero. `landing.tsx` owns copy/nav/footer and mounts
  `underwater-experience.tsx`, which renders `underwater-background.tsx`
  (`UnderwaterPointCloudBackground`, raw three.js, no R3F).
- Page order: hero → product demo stage (in-flow) → post-demo stack (team collab
  → bring-your-own subscriptions → agent fan-out
  (`landing-orchestration-section.tsx`: short claim + tags, no diagram) →
  CLI control plane (`landing-cli-section.tsx`: scripts/CI/integration + terminal) →
  power features → mobile/Dynamic Island → closing CTA → footer.
  No bottom ACP section / built-in runtime matrix. The ACP logo marquee lives INLINE
  inside subscriptions (the "any coding agent that speaks ACP" wall), not as a bottom
  footer strip. CTA platform detection lives in `landing-cta-section.tsx`
  (iOS → App Store; desktop → updates.lody.ai; Android → APK).
- Product demos are an ordinary in-flow section (tabs + `LandingAppPreview`). Desktop
  (fine pointer): a light downward nudge on the hero spring-scrolls to the stage; past
  that, free scroll. Touch / mobile: free document scroll only (no auto-spring, no
  Scroll chevron). Preview frame is `pointer-events: none` so nested chat/scroll UI
  cannot trap wheel/touch — only feature tabs are clickable. Hero is 100dvh on all
  breakpoints so the product demo never peeks on first paint. The desktop scroll hint
  keeps its localized label and animated chevron visually centered in equal-height
  boxes. No CSS scroll-snap.
- The power-section usage frame accepts native manual scrolling and preserves default
  scroll chaining so reaching either boundary returns the wheel/touch gesture to the
  document. It rotates ranges only when visible, so number/chart transitions do not
  create permanent background work. Document scroll drives only the display-only PR
  frame's internal progress, starting once half of the frame is visible and using eased
  ends. The usage preview must define the complete `--chart-1` through `--chart-5`
  palette inside its isolated theme scope; otherwise heatmap cells or later donut
  segments resolve to transparent backgrounds. Its narrow 7-day matrix also keeps dot
  height coupled to the final constrained width so the 24-column layout cannot stretch
  circles into capsules.
- Dynamic Island is **not** simulated in the play stage — real device media in
  `landing-mobile-deep-section.tsx` only.
- No scroll dive: hero + demo stage + post-demo are ordinary flow; point-cloud camera
  stays static (`diveRef` always 0). Portrait framing pan is **width-only**
  (`framingPanX`); never re-derive pan from live aspect — Safari chrome show/hide thrash
  would re-frame mid-scroll. `.underwater-bg` uses `100lvh` (not `inset:0`/`100dvh`) so
  the canvas height does not resize with the URL bar. Demos unlock once (first stage
  reach / intersect) and stay mounted — scroll must not null `demo` or remount ghost
  scripts. Off-screen, tab fill freezes via `animation-play-state` only. Ghost pointer:
  `scrollIntoView` no-op + `focus({preventScroll})` while demos run; `ghostEnabled` false
  when stage &lt; ~55% visible so clicks/drags stop.
- Feature carousel: `landing-feature-tabs.tsx` auto-advances over worktree / diff /
  design / mobile; each drives `LandingAppPreview` `demo`. Ghost scripts must not call
  `focus()` (browser scrollIntoView yanks the page); use `clickQuiet` and controlled
  state for typing.
- `landing-agents-section.tsx` (count lockup + built-in runtime matrix) and
  `landing-control-plane.tsx` stay unmounted reference components on disk.
  `landing-agent-banner.tsx` IS mounted: the subscriptions section renders it with the
  `inline` prop as the ACP logo wall (`.uw-agents__banner--inline` drops the legacy
  absolute footer positioning). Both provider marks and the wall come from
  `landing-agents.generated.ts`
  (`pnpm --filter @lody/site-docs generate:landing-agents`).
- `underwater-background.tsx` is client-only three.js in `useEffect`. Startup is
  deliberately staged — keep all three legs when touching it: (1)
  `underwater-experience.tsx` loads it via module-eval `import()` + `lazy` (keep the
  `.underwater-bg` CSS gradient in sync with the BG shader); (2) the initial seabed
  attributes are computed in `underwater-terrain.worker.ts` via
  `underwater-terrain-math.ts` and fade in through the terrain `uReveal` uniform, while
  gradient/particles/jellyfish render immediately; (3) first render waits on
  `renderer.compileAsync` (`ready` gate). Tune/downgrade rebuilds stay synchronous on
  the main thread.
- `underwater-experience.tsx` must mount `landing-app-preview.tsx` via `lazy()` —
  deliberately NOT module-eval `import()` like the background. The `previewArmed` latch
  fires one viewport ahead (idle fallback for non-scrollers) and never flips back, so the
  frame is filled before arrival and ghost scripts never remount. Tab durations + the
  demo id union live in `landing-demo-durations.ts`; importing them from the preview
  would pull it back into the critical chunk. The stage frame carries `aria-hidden` +
  `inert`.

## Product replica fidelity

- The desktop session shell must track `packages/components/src/components/sessions`
  1:1 — read that directory's `AGENTS.md` before touching it, and match the shape
  recorded in
  [landing and marketing internals](../../.agents/docs/site-landing-and-marketing.md).
  The right panel starts CLOSED (`DEFAULT_SIDE_PANEL_STATE.open === false` in
  `lib/session-detail-initial-state.ts`); only a demo that scripts the toggle opens it.
- The desktop CHAT LANDING has no Local/GitHub/Chat `ContextSwitch` any more. One
  `UnifiedProjectSelector` lists local projects and GitHub repos together and the
  context type is DERIVED from the selection (clearing it is the plain-chat context);
  the preview uses the platform-independent `UnifiedProjectSelectorView`. Its heading is
  the app's rotating `chat.heading` / `chat.heading2` copy.
- The mobile session shell is the `if (isMobile)` branch of `session-detail.tsx`, not a
  narrow desktop; keep it matching the mobile shape recorded in
  [landing and marketing internals](../../.agents/docs/site-landing-and-marketing.md)
  and [context/landing-demos.md](../context/landing-demos.md).
