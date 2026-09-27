# Keep new-chat attachment controls inside the mobile modal

Status: implemented
Translation: current

PR: [#1038](https://github.com/LodyAI/Lody/pull/1038)

[中文](2026-09-27-mobile-new-chat-attachment-menu.zh.md)

## Abstract

The mobile new-chat attachment menu could render outside the Vaul modal's
interaction boundary, leaving visible actions untappable. The sheet now provides
an internal popup container outside its scrolling content, marked to exclude
drawer dragging. The hidden file input also lives with the mobile composer inside
the sheet. Physical iOS file-picker behavior still requires user verification.

## Decision and evidence

`Menu.Content` defaults to a body portal unless its owner provides a container.
`MobileNewChatSheet` previously supplied none, the same modal-boundary hazard
documented in [mobile layering](../../../docs/ui-mobile.md#stacking).
Use the existing `PopupContainerProvider` contract for this sheet rather than
disabling modal interaction protection or raising the menu's z-index. A sibling
portal target outside the scroll region avoids clipping; `data-vaul-no-drag`
keeps touches on menu actions from starting a drawer drag.

Both mobile landing branches reuse the sheet's single file input. Desktop keeps
its existing input. File selection remains synchronous with the menu action;
file routing and upload state are unchanged. The external input's placement was
an additional containment concern, not a separately reproduced iOS failure.

## Verification limits

This checkout has no installed dependencies, so component tests and TypeScript
checks cannot run. Validate home and project entry points on iOS: open new chat,
tap + then Add attachment, choose/cancel a file and reopen the picker. Also check
the MCP panel and back action, and verify the sheet remains open after selection.
Documentation checking has pre-existing missing-submodule link errors.
