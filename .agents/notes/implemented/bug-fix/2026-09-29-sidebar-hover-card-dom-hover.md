# Sidebar hover cards judge hover on the DOM

Status: implemented
Translation: current

[中文](2026-09-29-sidebar-hover-card-dom-hover.zh.md)

## Abstract

With the sidebar filter menu open, the machine card for the first machine group
opened on top of the menu and flashed while the pointer crossed between them
([#1105](https://github.com/LodyAI/Lody/issues/1105)). The menu is portalled,
but in the React tree it is a descendant of the machine header, which is the
hover card's trigger. React's pointer enter and leave events follow the React
tree, so a pointer inside the menu counted as a pointer on the header. The
shared `SidebarHoverCard` now judges hover with native DOM listeners and does
not open while a popup opened from inside its trigger is open. Neither change
adds an API, and the sidebar passes no extra state.

## Problem

`SidebarFilterPopover` renders in-flow as the first section header's `action`
([in-flow trigger](2026-09-22-sidebar-filter-trigger-in-flow.md)). That header
is wrapped in `SidebarMachineHoverCard`, which is `SidebarHoverCard`. The
trigger listened with React's `onPointerEnter`, `onPointerLeave` and
`onPointerDown`. React builds enter and leave events from the component tree,
and events from a portal propagate to its React ancestors. The filter menu is
portalled, yet it stays a React child of the trigger `div`. As a result:

- moving from the machine name into the menu produced no leave, so the warmup
  was not cancelled and the card opened about 650ms later on top of the menu,
  or at once if the warm window was still open;
- entering the menu from anywhere else counted as entering the header;
- a press inside the menu counted as a press on the header.

The 180ms close grace mentioned in the issue does not start on the move from
header to menu: that move never left the trigger in React's view.

The same shell wraps conversation rows, whose portalled context menus sit in
the row's React tree in the same way.

## Decision

- **Hover is a DOM fact.** `SidebarHoverCard` attaches native `pointerenter`,
  `pointerleave` and `pointerdown` listeners to its trigger element. Native
  events follow the DOM, so a portalled descendant is outside the trigger. The
  card surface keeps its React handlers. There, following the React tree is
  wanted: a popup opened from inside the card keeps the card open.
- **An open popup owned by the trigger wins.** A hover does not open the card
  while an element inside the trigger has `aria-haspopup` and
  `aria-expanded="true"`. Base UI popover and menu triggers set both while open.
  A collapsible section toggle carries `aria-expanded` alone, and a tooltip
  trigger sets neither, so neither blocks the card. Opening a menu with the
  mouse already closes the card through press suppression, so only the open
  path checks.

Rejected:

- **A `blocked` prop fed from the sidebar's `sidebarFilterOpen`.** It hides the
  symptom at one call site. The portal problem stays in every other hover card,
  the sidebar has to know the card's rules, and `blocked` sits next to the
  near-synonym `disabled`.
- **Wrapping only the machine label in the hover card.** This changes the
  header API, and conversation rows still carry portalled context menus in
  their trigger.
- **Raising the filter menu's stacking order.** The card would still mount
  under the pointer.

## Verification

- `packages/components/tests/sidebar-machine-card.test.tsx` renders the product
  composition: a machine card around an expanded section header whose action is
  the real `SidebarFilterPopover`. With the menu open, dwelling on the machine
  name and then crossing into the menu keeps the card shut. After the menu
  closes, a hover opens the card, even though the header toggle still reports
  `aria-expanded="true"`.
- `packages/components/tests/session-info-hover-card.test.tsx` gives the trigger
  a portalled child. Moving into it cancels the warmup, entering it directly
  does not open the card, and a press inside it does not suppress the trigger.
- `tests/helpers/pointer-boundary.ts` fires the event sequence a browser sends
  on a pointer move: over and out, then enter and leave on each DOM ancestor.
  jsdom derives neither pair from the other, so these tests exercise both React
  and native listeners.
- Not verified in a live Electron session. jsdom does not paint two portalled
  popups overlapping.
