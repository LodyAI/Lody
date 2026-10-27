# Session stories and the Storybook-fidelity invariant

Which stories exist for this directory and what a story may and may not own.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- Stories: composer/input-area/queue/draft variants under `src/stories/`;
  attachment-rich list case is `SessionChatStream` → `HumanAndAgentAttachments`;
  shared full-page session conversation coverage is `SessionConversationPage.stories.tsx`
  using `session-conversation-page.tsx`.
- `SessionConversationPage` → `DesktopReadingReview` combines synthetic thinking,
  tool calls and results, inline diffs, edited-file summaries, comment references,
  visual annotation references, and Markdown in the real conversation renderers.
  It uses a builtin DeepSeek session because that provider exposes thought prose.
  Light, wide, working, permission and question variants share this history; mobile
  variants cover the same reading, working, permission and question states. A file
  click opens the real desktop diff panel or mobile diff drawer using a fake file
  provider. `DesktopReadingReviewAnnotations` opens the real managed-preview surface
  with an inert page and in-memory annotation: its comment can be collapsed or
  resolved, but the fixture does not exercise a live inspector or transport.
- `ConversationDiffPanel` uses a synthetic 200-file provider with the real diff panel.
  `OpenFromChanges` starts without a mounted diff; its Changes button mounts the panel
  inside the real `DesktopSessionDetailLayout`, including its sidebar transition.
  Close unmounts it so another click exercises reopening. Reload the preview before
  assessing a cold first open. The opener is a small synthetic harness; it does not
  run `SessionDetail`'s turn-summary, tab or RPC controllers, or measure Electron latency.
  `ManyFiles`, `FocusLastFile` and `AllChanges` cover the already-open panel states.
- `MobileDiffDrawer` renders the real shared changes list, mobile drawer and diff
  panel with four synthetic code/doc/test entries. `Changes` exercises list →
  selected diff → Back, Types/Files selection and retained hidden panel state;
  `Loading` uses the real summary-loading state. It has no native transport or
  full SessionDetail runtime and does not validate physical-device gestures.
- `SessionInfoBar` → `DiscoveredPrAssociationRejected` feeds synthetic owner
  metadata through production PR selection/action gating into the real bar,
  without hosted mutations. Run `pnpm --filter @lody/components exec playwright test
tests/e2e/session-info-bar-observation.spec.ts --workers=1` for its browser
  regression and ignored screenshot output. The optional `B08_SCREENSHOT_FIXTURES`
  directory supplies scheduler-captured `before.json` / `after.json` for comparison;
  see the [observation decision](../notes/proposed/bug-fix/2026-10-01-pr-observation-association.md)
  for evidence and acceptance limits.
- Browser Preview has `States` (`SessionBrowserPreview.stories.tsx`) for deterministic
  presentation and `Controller` (`SessionBrowserPanel.stories.tsx`) for real Enter and
  restore handlers with synthetic RPC data. Both use production presentation:
  `SessionBrowserPanel` → `SessionBrowserPanelView` → toolbar/status/surface.
  The status stories render the real address-bar icon and its details popover, including
  open-popover, narrow, dark and Chinese variants. State stories use the real Managed
  Preview surface with an inert `documentHtml` fixture; they do not validate tunnel
  transport or annotation messaging. Native `WebContentsView` content cannot be rendered
  in web Storybook; its unsupported browser state is covered instead. Theme/locale
  controls apply to state stories; controller play assertions run in English.
  Run `pnpm --filter @lody/components exec playwright test
tests/e2e/browser-preview-stories.spec.ts --workers=1` for every registered Browser
  story, recovery-button assertions, browser errors, open-popover assertions, and
  per-story screenshots in Playwright's ignored output directory. Screenshots are review
  artifacts, not git files.
- **Storybook-fidelity invariant (stories mirror production, they don't own UI).**
  A `*.stories.tsx` may only mock data/providers and render the REAL component.
  NEVER put appearance (color/spacing/border/sizing that changes how a component
  looks) in a story — it must live in the component under `src/components/**` or
  it never reaches production. To iterate on a component's look, edit the
  component and preview via its DEDICATED story (e.g. `PermissionRequestCard.stories.tsx`,
  which renders that real component directly). `SessionConversationPage.stories.tsx`
  is an INTEGRATION harness: the real page (`session-chat-interface.tsx` /
  `session-detail.tsx`) can't render in Storybook (needs the workspace
  runtime/Convex/Machine-RPC), so it hand-composes leaf components. That
  hand-composition MUST mirror production and drifts silently — keep it minimal
  and keep these in sync: (1) mobile vs desktop header mirrors `session-detail.tsx`
  `if (isMobile)` (mobile `BaseHeader`, `...` menu top-right via `actions`) and
  the desktop merged `SessionTabBar` row + context strip (see the top-bar bullet
  above); (2) `useIsMobile()` reads
  `window.innerWidth` (not any CSS phone frame) → mobile stories resize the
  preview iframe via the `withMobileViewport` decorator so `isMobile` is true;
  (3) mobile renders full-bleed (no fake bezel/padding). After ANY UI change,
  verify in the real app (mobile included) — a story's preview chrome is not
  production. Audit tip: `grep -nE '(bg-|text-|rounded-|shadow-|border-|w-\[|h-\[)' src/stories/*.stories.tsx`
  on component instances is a smell; that styling belongs in the component.
