# Settings editor dialogs: popups, panel colour and a vanishing Shortcut editor

Status: implemented
Translation: current

[中文](2026-09-28-settings-editor-dialog-popups.zh.md)

## Abstract

The Prompt Shortcut and Agent Role editors showed four defects: a stray chevron
over the first row of a long Select list, a band of empty panel under the footer
after opening a few Selects, a gray panel unlike the white settings page, and, in
the desktop build, a Shortcut editor that closed by itself. They had four
separate causes. Each is fixed where it starts: popup portals no longer take
layout space, the Select scroll arrows state their own edges, the light product
palette maps the modal and card surfaces to the raised widget colour, and the
cloud platform object no longer changes identity when a session is refetched.
Only the platform fix has a unit test. The layout and colour fixes were measured
in Chromium, because jsdom does not apply StyleX CSS.

## Causes and fixes

- **Empty band under the footer.** Base UI mounts every popup through a `<div>`
  of its own, appended to the container. Inside a dialog that container is the
  panel, a flex column with a 16px `gap`. Each opened Select therefore added one
  flex item and one gap, and those portal elements stayed mounted after the list
  closed. With the panel at its `max-height`, the form shrank by 16px per Select
  (measured: 582 → 518px after four). Every floating part's portal now takes
  `portalClassName` (`display: contents`). The positioner inside it is out of
  flow either way.
- **Chevron over "None".** Base UI renders the scroll arrows with an inline
  `position: absolute` and leaves the insets to the host. With no insets, an
  absolutely positioned child of the popup's flex column sits at the start of the
  box, so the down arrow drew over the first row. `surface.scrollArrowUp` and
  `surface.scrollArrowDown` pin them across the top and bottom edges, with the
  popup's outer radius. `surface.scrollArrow` stays unpositioned for the gallery
  sample.
- **List hanging left of its trigger.** Base UI centres an anchored list on its
  trigger, so a list wider than the trigger hung past its start edge.
  `Select.Content` now defaults to `align="start"`.
- **Gray panel.** #961 mapped `elevatedBackground`, the card and modal rung, to
  `hsl(var(--card))`. In a light theme `--card` is the sidebar, one step _below_
  the canvas (Lody Light `240 14% 94.1%`, which renders as `rgb(239,239,241)`), so
  every dialog and product card turned sidebar gray. Before #961 these surfaces
  used the package's white. The settings pane had already worked around this with
  its light-only `--card: var(--popover)` remap, but a dialog is portalled out of
  the pane. The light palette now maps `elevatedBackground` to `--popover`. Dark
  keeps `--card`, the deep-sea step that palette was tuned on.
- **Shortcut editor closing by itself (cloud build).** `useStableSession` refetches
  the session on window focus and on a 5-minute keepalive. Each refetch returns a
  new `user` object, so `createOrganization` changed identity, and with it
  `CloudPlatformProvider`'s memoised platform. The Prompt Shortcut provider fences
  its runtime on `instance.platform === platform` (#989), so `runtime` became
  `null`. The settings list is keyed on whether a runtime exists, so it remounted
  and dropped the editor draft. The provider's methods now read their callbacks
  from a ref, and the platform object changes only with `localAgentSyncMode`.

## Alternatives considered

- _A dedicated out-of-flow layer inside the panel as the popup container._ It
  would fix only Dialog, AlertDialog and Drawer. A host's own
  `PopupContainerProvider`, such as the mobile new-chat sheet, would keep the bug.
- _Keying the Shortcut settings on identity instead of runtime presence._ That
  hides the symptom for one consumer and leaves every other per-platform resource
  rebuilding on refetch. It also does not help while the session status is
  `loading`.

## Limits

- A refetch that _fails_ still sets the session to `loading` while it retries
  (`cloud-platform-provider.tsx`). `userId` then reads `null` and the Shortcut
  editor remounts the same way. This path is less likely and is not changed here.
- In light mode, product cards outside Settings that use `elevatedBackground`
  (question and permission cards, the archive, onboarding) return to the white
  they had before #961.

## Verification

- `tests/cloud-platform-provider.test.tsx` refetches equal session data in new
  objects and asserts that the platform object is the same and that it calls the
  latest `createOrganization`. The test fails against the previous provider.
- Chromium, with a throwaway Storybook story of both editors in the product
  `Dialog` at the settings width and height: after opening and closing all five
  Role Selects, the form stays at 582px. The panel measures `rgb(255,255,255)`,
  up from `rgb(239,239,241)`. On a 30-row list the arrows sit at the popup's top
  and bottom edges, and the list's left edge matches its trigger's.
