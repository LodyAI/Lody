# Route close actions through semantic scopes

Status: implemented
Translation: current

[中文](2026-09-22-semantic-action-targeting.zh.md)

## Abstract

Desktop tab close tracks clicks and focus but ignores pointer movement, so moving
to the right panel can still close a conversation or its window. A default-off Developer Mode beta now routes native Cmd/Ctrl+W through a
window-local semantic scope resolver. Pointer and keyboard intent select the surface while
existing surface handlers retain close lifecycle ownership. An empty panel
collapses and hands focus back for the next invocation; blocked or cancelled closes must
not fall through to another region. Targeted tests pass; full product-window and cross-origin preview interaction
validation remains outstanding.

## Evidence and responsibilities

[SessionDetail](../../../../packages/components/src/components/sessions/session-detail.tsx)
already marks the right panel with `data-lody-session-tab-region="side-panel"`.
Its root tracks pointer-down and focus capture, not pointer movement. The default
region is conversation; unmarked descendants are treated as conversation.
[The close resolver](../../../../packages/components/src/components/sessions/session-tab-close-target.ts)
selects the window for one conversation tab and also for an empty focused panel
when the conversation uses the empty sentinel.

[The shell closer](../../../../packages/components/src/lib/desktop-tab-or-window-close.ts)
uses the latest mounted closer and calls `window.close()` for `unhandled` or no
closer. [Command rules](../../../../packages/components/src/lib/commands/AGENTS.md)
require the native accelerator and forbid a duplicate renderer Mod+W binding.
The proposal preserves that entry point and the deliberate conversation-window
policy in [the previous decision](../bug-fix/2026-09-21-last-tab-window-close.md).
The [conversation closure Spec](../../../../specs/session-tab-closure.md) now
distinguishes explicit final-draft tab closure from the native window-close
accelerator, correcting its stale wording to agree with the desktop window Spec.

## Implementation

Product behavior belongs to [the draft Spec](../../../../specs/semantic-action-targeting.md).
`semanticShortcutsFeatureEnabledAtom` combines the developer master switch with a
persistent, default-false device opt-in. The Beta settings row controls that choice.
`useSemanticActionRouter` installs the input listeners only while enabled on an
Electron SessionDetail and resets them on Session identity changes or cleanup.

`semantic-action-router.ts` resolves the innermost visible registered DOM scope.
The two session columns declare `data-lody-action-scope`; SessionDetail supplies
current close handlers. Hover updates a tab-strip cue without moving the caret;
subsequent typing or keyboard navigation takes ownership back. Programmatic focus
restoration does not override pointer intent. Mod+W uses the existing TanStack
matcher and never creates a second close binding. Open modal/menu layers block
background close; unavailable or removed targets consume the invocation. Only
an explicit target-handler result may yield to native window close.

Empty right panels collapse. A visible-to-hidden transition in the same Session
transfers scope and composer focus to the conversation. Dirty confirmation,
Side Chat termination, errors, and pending close remain in existing handlers.
Normal repeat dispatch remains unchanged, as explicitly requested; no repeat lock,
modifier-release requirement, or timer was introduced. Hover dwell is deferred.

The public-browser native view observes Electron input at the host boundary and
publishes `publicBrowser.interaction` only to its focused owner window while visible
and opted in. The existing visibility IPC carries the tracking flag, so disabling
the beta stops native input pushes as well as renderer consumption.
The payload contains browser id and source class only. The visible renderer host
consumes it only with the feature enabled and dispatches a DOM ownership signal
from its registered surface; no webpage content, key text, preload, or script
injection is added. Iframe pointer entry uses the host pointerover event, without reading the frame.
Keyboard input inside cross-origin Managed Preview frames still needs a separate
bridge and remains outside this beta.

## Comparable designs and revision

Research on 2026-09-22 distinguishes documented behavior from user requests and
historical bug reports; none establishes a universal close policy.

| Primary source | Evidence | Consequence for this proposal |
| --- | --- | --- |
| [VS Code 1.57 release notes](https://code.visualstudio.com/updates/v1_57#_removed-cmdw-ctrlw-keybinding-to-close-window-when-no-editor-is-opened) | Removed the empty-editor window-close binding after rapid close presses unexpectedly closed windows. | Repeated independent presses can surprise users too; suppressing key auto-repeat alone does not solve window escalation. |
| [Zed pane-layout request #14817](https://github.com/zed-industries/zed/issues/14817) | Users request stable empty panes and explicit Cmd+W on an empty pane to close it. This is a request, not proof of shipped behavior. | Empty content can still have a closeable container; silent consumption is not the only safe option. |
| [Zed focus settings](https://zed.dev/docs/reference/all-settings#focus-follows-mouse) | Hover focus defaults off and supports a 250 ms dwell. | Immediate hover ownership needs validation; it is not an established default. |
| [iTerm2 #10167](https://gitlab.com/gnachman/iterm2/-/issues/10167) | A user reports focus stealing while crossing a terminal on the way to a Dock menu. | Pointer transit and menus need protection. This concerns full focus transfer, an analogy rather than direct evidence against action-only routing. |
| [VS Code #189256](https://github.com/microsoft/vscode/issues/189256) | An empty group appeared active while typing still affected the previous editor. | The visual target, keyboard focus, and action ownership must agree after layout transitions. |

Revise the initial no-op proposal: empty visible right panels collapse themselves;
a successful collapse transfers focus and active scope to the conversation. Later invocations can close there, including ordinary key repeat. Repeat
suppression from the initial design was explicitly dropped for this implementation. Cancellation, pending work, and failure remain
owned by the original surface. Hidden panels are excluded rather than treated as
permanent empty targets. This separates one invocation falling through from a
legitimate later action after focus transfer.

The existing one-conversation-tab window-close policy is retained only to bound
this proposal, not because research validates it. VS Code's reversal is evidence
for separately reviewing that policy. Zed also exposes an explicit
[no-tabs window policy](https://zed.dev/docs/reference/all-settings#when-closing-with-no-tabs),
showing that container and window closure need distinct decisions. Hover-only
action targeting differs from focus-follows-mouse: test whether it creates two
conflicting notions of the active pane before adopting it.

## Verification and limits

The owning desktop-close suite exercises real DOM input, native-close dispatch,
selection, nesting, visibility, cancellation/pending ownership, modal/menu guards,
keyboard reclaim, programmatic focus, blur, pointer exit, dragging, route reset,
and live feature gating. Browser input tests exercise event delivery and cleanup
without forwarding key text. The layout and Beta settings stories include the
opt-in and empty-panel states; the layout story uses F8 as a browser-safe close trigger.

All 53 targeted Vitest cases and 11 Electron close, IPC, and browser tests pass.
Strict standalone type checking passes for the router, hook, and native input adapter.
Changed source files pass Oxfmt and the i18n check passes. A standalone Chromium fixture
using the production router verifies hover without click, the active cue, emptying
and collapsing the right panel, focus transfer, subsequent conversation close, and entering a cross-origin iframe.
This is a routing fixture, not a full product/Electron end-to-end run.
The installed Node 26 environment requires `NODE_OPTIONS=--no-experimental-webstorage`
for jsdom storage tests. Dependencies were reused from the existing checkout
without installing another workspace graph.

Full repository checks are blocked by missing workspace/submodule dependencies;
public-boundary checks also report unresolved ACP submodules. Documentation checks
retain existing submodule link failures. Native menu delivery and native view focus
ordering still require full product validation; cross-origin Managed Preview
keyboard input remains outside the beta. No approval or measured usability benefit is claimed.

## Pull request

[Draft PR #912](https://github.com/LodyAI/Lody/pull/912) targets `main`.
