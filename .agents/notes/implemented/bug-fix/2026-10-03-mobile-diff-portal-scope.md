# Keep the mobile diff inside the session drawer's modal scope

Status: implemented
Date: 2026-10-03
Translation: current

[中文](2026-10-03-mobile-diff-portal-scope.zh.md)

## Abstract

The mobile diff uses a Base UI drawer inside a legacy Vaul/Radix session drawer. Portalling the diff to the body lets it inherit the outer modal's pointer lock, so scrolling over the visible diff can move the conversation underneath. The mobile diff content now explicitly uses the enclosing drawer's boxless popup host. This preserves the modal scope without changing global modal positioning; Android touch behavior and the full file-viewer flow still need device validation.

## Decision and evidence

The UI migration replaced the mobile diff sheet with `@lody/ui`'s drawer. Its default container is the body, while the session's Vaul/Radix drawer sets body pointer events to `none` and its own content to `auto`. The existing `DrawerContent` popup host is inside that content and outside scrolling children.

`SessionMobileDiffDrawerContent` reads `usePopupContainer` and passes it explicitly to `Drawer.Content`. The existing root, close handling, diff data, and file handoff remain unchanged. A surface without an enclosing provider retains the primitive's body default. Changing every modal's default container was rejected because transformed ancestor panels can change fixed modal positioning.

A synthetic fixture using Vaul 1.1.2 and Base UI 1.7.0 was exercised with Computer Use in Lody's built-in browser. A one-page scroll over a body-portalled diff moved background chat from 0 to 641 px and left the diff at 0. With the portal inside the outer drawer, the same scroll moved the diff from 0 to 641 px while the background stayed at 641 px; reversing it moved only the diff. This is component-combination evidence, not a full Android release reproduction.

The separate [mobile diff file handoff](2026-09-28-mobile-diff-file-handoff.md) remains necessary: opening a source file still closes the diff first. Implementation context: [session file surfaces](../../../docs/sessions-file-surfaces.md).

## Verification

The existing drawer suite adds the real mobile diff content inside the real session drawer, covering initially open and click-open states. It checks modal containment, effective pointer events, focus retention, line selection, and closing only the inner drawer. JSDOM does not verify native scroll hit testing; browser and Android validation remain distinct checks.

The drawer, mobile file viewer, file content view, and conversation diff data suites pass (61 tests). Removing the explicit container makes both new regression cases fail; restoring it passes. Components typechecking, changed-file lint/format, root `pnpm format`, and the platform boundary guard pass. Root `pnpm check` stops at CLI typechecking because the Claude, Codex, Grok, and Devin ACP submodules are uninitialized. The public boundary and docs checks also report these missing submodules; no docs errors reference the changed files.
