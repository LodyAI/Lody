# Composer Role submenu placement

Status: implemented
Translation: current

[中文](2026-09-29-composer-role-submenu-placement.zh.md)

## Abstract

The docked landing composer’s Role submenu appeared far above its parent menu, while a first attempt to align it with the Role row covered the footer controls. Its fixed 17rem panes also left a large empty area beneath short Role lists. The submenu now centers against the parent menu when it fits, or keeps its bottom at the parent menu's bottom when taller. Content-driven panes are capped at 14rem. Parent, permission, and Role menus retain the shared popup inset rather than compensating for it with custom horizontal margins; long lists and details remain scrollable.

## Decision

The positioning decision is superseded by [trigger-row cascading placement](2026-09-30-composer-cascading-submenu-placement.md). The pane sizing and inset decisions remain in effect.

`DesktopRunConfigMenu` anchors the Role submenu to the parent menu’s popup. It centers vertically when shorter than the parent and shifts up by half the excess height when taller, keeping its bottom from extending beyond the parent's. The Role row still controls opening and selection, but anchoring the positioner to that row placed a tall pane over the footer controls at the bottom of the landing page. Vertical collision shifting keeps the pane on screen in smaller viewports. The list and detail pane no longer impose a fixed height; the 14rem cap bounds large content while each pane owns its own scrolling. The product does not cancel the shared popup's horizontal inset in either menu: that compensation made the parent and submenu rows appear uneven across contexts.

This remains a two-pane menu so users can inspect a Role’s configuration before selecting it. The Role rows alone scroll; Create stays at the bottom of the left pane without a separator, and the detail header has no divider before the pinned values. The cap may require scrolling to read a long instruction or reach additional Roles.

## Evidence and verification

- The reported desktop screenshot showed a 17rem submenu ending at the Role row, with a large blank area below the list and a wider leading inset than the parent menu.
- The `Sessions/ComposerRunConfigMenu` Storybook landing scene renders the production `ChatLandingView` with its composer docked to the bottom and the real run-config controls. At 915×760, the parent spans y=405–711 and the shorter Role submenu spans y=442–674, with 37px of space at each end. At 700×740, the submenu switches to a centered single-list presentation without horizontal overflow. In the taller existing-session detail scene at 915×760, the submenu ends with the parent at y=660. Selecting a Role closes the menu and updates the composer face. Light, dark, and Chinese menu states retain the same standard inset. Synthetic long-list stories show independent list and detail scrolling.
- The existing Role panel behavior tests and component typecheck cover selection and rendering; the Storybook scene verifies the browser’s actual popup positioning, which a DOM-only test cannot measure. In the long-list scene, the left pane spans y=446–670, the Role rows scroll within y=446–642, and Create stays at y=642–670 after scrolling.

## Remaining limit

A desktop-class window can be as narrow as 400px. In the source-component landing story, the compact submenu still occupies x=321–585px at 580px viewport width and below, so its right side is clipped. This is a distinct small-window navigation problem: neither side of the parent menu has room for a second popup. A drill-in presentation within the parent menu would avoid depending on adjacent horizontal space, but that interaction has not been implemented or verified in the desktop app. The local Electron app could not be launched in this checkout because its Claude, Codex, and Grok submodules are missing.

The existing-session story scopes Roles to the session's Agent and disables the Agent row, matching the session caller. Its detail pane still displays the Role's stored instruction, although an existing session applies only the Role's run configuration. That informational-versus-applied distinction is not apparent in the menu and remains a separate design question.

Current behavior is documented in [composer run config](../../../docs/sessions-run-config.md).
