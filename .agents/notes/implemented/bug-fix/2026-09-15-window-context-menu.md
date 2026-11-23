# The desktop window had no context menu at all

Status: implemented
Translation: current

[中文](2026-09-15-window-context-menu.zh.md)

## Abstract

Right-clicking anywhere in the desktop app did nothing: no Copy over selected conversation text, no Paste in the composer, nothing in any input. Chromium's context menu is built by the embedder rather than by the web platform, so Electron ships none and nothing in Lody had ever drawn one except the image preview's own popup; only the menu bar's Copy accelerator worked. A single `context-menu` handler on every product window now draws a native menu from `buildContextMenuTemplate`, which reads what Chromium reports about the click: an editable field gets undo/redo/cut/copy/paste/select-all with Chromium's own enablement, read-only text gets Copy, and an image is left to the renderer so one click never stacks two menus. Labels follow the product language rather than Chromium's packaged locale; the menu bar's edit items still do not, and that inconsistency is left standing.

## Decision

The menu is drawn in the main process, and the roles are Chromium's.

That is the whole point of putting it there: `{ role: 'paste' }` is executed by Chromium against the focused field, so the composer's textarea gets a real paste event and a real undo stack. A renderer-side menu would have to reimplement those over the clipboard API, and cannot offer paste at all without reading the clipboard itself.

A renderer implementation using the app's own `@/ui/context-menu` was built first and rejected (it survives on `fix/conversation-selection-context-menu`). It looked consistent with the sidebar, terminal and file-tree menus, and it worked on the web where the browser's own menu is better — but it reached only the conversation message area. The composer, the search field, settings inputs and every other panel would each have needed their own wrapper, and paste would still have been keyboard-only everywhere. Coverage beat visual consistency: the defect reported was "right-click does nothing", not "right-click does nothing in one panel". The cost is real and accepted — the text menu is an OS menu while every other right-click menu in the app is a styled Radix one.

Three details are load-bearing:

- **An image yields.** `image-export-service.ts` already draws a native menu for the image preview, driven from the renderer because it holds the only copy of the bytes. Both handlers see the same click, so `mediaType === 'image'` returns an empty template. Inline conversation images therefore still have no menu, exactly as before.
- **An empty template draws nothing.** A popup whose only entry is a disabled Copy reads as broken, so a right-click on blank space stays inert the way it always was. This also covers a selection Chromium will not let us copy.
- **`selectAll` is absent from the read-only branch.** Outside a field Chromium selects the whole focused document, so in the app shell it would sweep up the sidebar and every other panel rather than selecting "this". Inside a field it is exactly right and is kept.

The template builder is a pure module so it runs under `node --test` without the `electron` runtime, the same split `image-export-core.ts` uses. Wiring sits next to `installNavigationGuard` in `createMainWindow`, which is the one factory every product window goes through — main, auxiliary and onboarding. The public browser `WebContentsView` is deliberately not included: `src/AGENTS.md` keeps that surface minimal on purpose, and widening it is a separate decision.

Labels come from `translateMenu` in `menu.ts`, reusing the locale the renderer already pushes for the menu bar, so a Chinese app says 复制 on an English OS. `common.undo`, `common.redo`, `common.cut` and `common.selectAll` were added to both locale files; copy and paste already existed.

## Verification and limits

- `context-menu-template.test.mjs` covers the branches as pure data, and is mutation-checked: removing the image guard or the empty-template guard fails it.
- Driven in real Electron 39.5.1 under Xvfb against a throwaway page, with `Menu.prototype.popup` recording what it was handed (an OS menu runs a modal loop a probe cannot dismiss). Right-clicking with no selection drew nothing; a read-only selection drew `Copy` alone; a caret in a textarea drew the full edit set with cut/copy disabled and select-all enabled; a selection in that textarea enabled cut and copy; an image drew nothing; and after `setMenuLanguage('zh_CN')` the same clicks drew `复制` and `撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选`. That last case is what proves an explicit `label` overrides a role's default text.
- Paste showed disabled throughout because the headless probe had an empty clipboard — which is itself the enablement flags working.
- Role EXECUTION was not driven: a native menu item cannot be clicked from a probe. It is the same mechanism the menu bar's Edit items already use, which is how ⌘/Ctrl+C works in the app today.
- The packaged app was not rebuilt, and no macOS or Windows run was made; the probe is Linux.
