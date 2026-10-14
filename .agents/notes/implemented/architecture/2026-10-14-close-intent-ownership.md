# Preserve close intent across incidental pointer movement

Status: implemented
Translation: current

[中文](2026-10-14-close-intent-ownership.zh.md)

## Abstract

The pointer-aware close beta immediately replaced its target on mouse movement,
so returning to a single-tab conversation after opening a file could close or hide
the entire window. Explicit content actions now retain ownership across pointer
movement, with hover dwell used only before explicit ownership exists. Async opens
cannot override newer deliberate input, and weak selection cannot close the window
while another close scope remains visible. The trade-off is reduced hover-only
switching after explicit interaction; full Electron usability remains unverified.

## Evidence and decision

This revises the immediate-pointer policy in the
[earlier decision](2026-09-22-semantic-action-targeting.md), rather than correcting
an implementation that violated its Spec. The
[semantic-targeting Spec](../../../../specs/semantic-action-targeting.md) remains a
draft and owns the current intent. The device-local opt-in still defaults off and
requires Developer Mode.

The old [resolver](../../../../packages/components/src/lib/commands/semantic-action-router.ts)
combined pointer movement and clicks into one signal that could overwrite explicit
selection. [SessionDetail](../../../../packages/components/src/components/sessions/session-detail.tsx)
yields a lone conversation tab to native window close; the
[shell closer](../../../../packages/components/src/lib/desktop-tab-or-window-close.ts)
then calls `window.close()`. This explains how incidental motion escalated to the
macOS close/hide policy without changing shared Session state.

Sources inspected on 2026-10-14 support the design, not measured results for Lody:

| Primary source                                                                                                                      | Evidence and limit                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Zed focus settings](https://zed.dev/docs/reference/all-settings#focus-follows-mouse)                                               | Hover focus defaults off and supports a 250 ms dwell. This transfers keyboard focus, unlike Lody's action-only ownership.                 |
| [VS Code 1.57](https://code.visualstudio.com/updates/v1_57#_removed-cmdw-ctrlw-keybinding-to-close-window-when-no-editor-is-opened) | Removed empty-editor Cmd/Ctrl+W window closing after unexpected rapid-press closures. It retained a dedicated window-close shortcut.      |
| [Zed empty-window policy](https://zed.dev/docs/reference/all-settings#when-closing-with-no-tabs)                                    | Exposes a keep-window-open option; it does not determine Lody's last-conversation-tab policy.                                             |
| [menu-aim](https://github.com/kamens/jQuery-menu-aim)                                                                               | Cursor direction distinguishes transit from intentional menu hover; submenu geometry does not directly transfer to two content panes.     |
| [Horvitz, CHI 1999](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/chi99horvitz.pdf)                           | Recommends considering uncertainty, action cost, recent interaction memory, and user control. It does not specify a pane-close algorithm. |

## Ownership and responsibilities

The window-local resolver retains an explicit or hover owner and one pending hover
candidate. Ordinary movement cannot replace an explicit owner, even after a long
pause. Clicks, keyboard input/navigation, non-zoom wheel input, and explicit
open/select actions claim their destination immediately. Programmatic focus and
scroll restoration do not claim ownership. Without explicit ownership, hover
commits after 250 ms continuously in the same visible scope. Movement within that
scope does not restart the timer.

| Transition                                                              | Result                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Open a right-panel file, then return the pointer to the conversation    | Keep the right-panel close target.                                      |
| Click, type, navigate, or wheel-scroll in the conversation              | Transfer explicit ownership to the conversation.                        |
| Cross a pane without an explicit owner                                  | Keep the committed target until dwell completes.                        |
| Close the final panel tab successfully                                  | Collapse and deliberately transfer ownership/focus to the conversation. |
| Close a lone conversation selected only by hover/focus/default fallback | Consume the action while another visible close scope exists.            |

The existing cue shows committed ownership, not a pending candidate. Native menu
routing, normal key repeat, dirty confirmations, Side Chat lifecycle, and
cancelled/failed close ownership remain with their existing handlers. Hidden or
removed targets consume rather than redirect. A deliberate conversation action
can still close a lone conversation's window; a later invocation after successful
panel collapse can do the same. This guard does not silently close another pane.

File opens resolve paths asynchronously. `deferActivation` captures a generation
at invocation and returns a completion callback; newer deliberate input, another
open request, reset, or disposal invalidates it. After the viewer tab is upserted,
the callback may claim its destination even before React commits that scope; until
it becomes visible, dispatch is an owned no-op. An open that creates no tab never
calls completion. Viewer opens and explicit sidebar/tab selections use the same
resolver ref; restored state does not claim explicit ownership merely by mounting.

[The native browser adapter](../../../../apps/electron/src/main/services/public-browser-interaction.ts)
now distinguishes movement, click, exit, wheel, and keyboard classes. Only browser
id and source class cross the bridge, with no coordinates, page content, or typed
keys. Close accelerators and modifier-only input do not claim ownership. Movement
and exit use the same hover rules as renderer scopes; clicks, wheel, and keyboard
input claim explicit ownership. Visibility and feature gates still control delivery.

## Alternatives and remaining costs

Dwell alone filters crossings but still misclassifies a parked pointer. Cursor
velocity/direction cannot recover purpose from a stationary pointer. Always
preferring the right panel misroutes deliberate conversation-tab closes.

A recency score or Bayesian model would need labeled intent examples and calibrated
error costs; arbitrary weights are not probabilities. Explicit ownership provides
an explainable first implementation without training or product telemetry. A
content-only Cmd+W policy and dedicated window-close command remain a separate
product decision. No new confirmation or global window-close binding is introduced.

## Verification and limits

The owning DOM close suite covers the reported parked-pointer workflow, deliberate
reclaim, programmatic restoration, dwell boundaries and cancellation, weak-window
protection, stale async activation, native interaction classes, and live feature/route
cleanup. Tests assert panel, tab, focus, and window state using fake timers. Run:

```sh
NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/desktop-tab-or-window-close.test.tsx tests/session-tab-close-target.test.ts
node --test apps/electron/src/main/services/public-browser-state.test.mjs apps/electron/src/main/close-focused-tab-or-window.test.mjs apps/electron/src/main/ipc/ipc-channel-list.test.mjs
```

A Chromium fixture loaded the production resolver and used real pointer/click
input. It verified file-open ownership after returning the pointer, deliberate
conversation reclaim, hover dwell without caret movement, weak-window abstention,
stale async claims, and sequential close after panel collapse. Native-close delivery
was simulated; this is not a full product/Electron end-to-end run.

The desktop-close suite passes all 54 cases and the targeted Electron suites pass
all 11 cases. Strict type checking of the router/hook, changed-source lint/format
checks, and i18n validation pass. The separate session-tab-target suite cannot
collect because the shared index imports missing `mdast-util-from-markdown`.
Adapter-inclusive and full type checks are blocked by incompatible installed
Effect/ACP libraries and missing dependencies; root `pnpm check` cannot complete.
Public-boundary checks report unresolved ACP workspace submodules. Documentation
checks report 82 broken links outside the changed documents and no protected topics.
Dependencies were reused without installing a nested workspace graph.
No usability improvement or native-view focus ordering is claimed as measured;
Managed Preview cross-origin keyboard input remains outside the existing bridge.

## Pull request

[PR #1558](https://github.com/LodyAI/Lody/pull/1558) targets `main`.
