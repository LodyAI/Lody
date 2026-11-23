import { Menu, type BrowserWindow } from 'electron'
import { buildContextMenuTemplate, type ContextMenuLabels } from './context-menu-template'
import { translateMenu } from './menu'

/**
 * Give a product window the context menu Electron does not ship. One handler
 * covers every surface the window renders — conversation text, the composer,
 * search fields, settings inputs — because Chromium reports what was clicked
 * and which edit actions are currently legal.
 *
 * Labels follow the PRODUCT language rather than Chromium's packaged locale, so
 * a Chinese app says 复制 on an English OS. The menu bar's own edit items use
 * bare roles and therefore do not; this is the better behaviour, and the two
 * can converge later.
 */
export function installContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, resolveLabels())
    if (template.length === 0 || window.isDestroyed()) {
      return
    }
    Menu.buildFromTemplate(template).popup({ window })
  })
}

function resolveLabels(): ContextMenuLabels {
  return {
    undo: translateMenu('common.undo', 'Undo'),
    redo: translateMenu('common.redo', 'Redo'),
    cut: translateMenu('common.cut', 'Cut'),
    copy: translateMenu('common.copy', 'Copy'),
    paste: translateMenu('common.paste', 'Paste'),
    selectAll: translateMenu('common.selectAll', 'Select All')
  }
}
