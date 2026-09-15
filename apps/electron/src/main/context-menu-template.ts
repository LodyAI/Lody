/**
 * Pure template construction for the window context menu. Kept apart from
 * `context-menu.ts` so it stays importable (and testable) without the
 * `electron` runtime, the same split `image-export-core.ts` uses.
 *
 * Chromium's own context menu is built by the embedder, not by the web
 * platform, so Electron ships none and a right-click did nothing anywhere in
 * the app. Drawing it here rather than in the renderer is what gets correct
 * cut/paste/undo semantics in the composer and every other input: the roles
 * below are executed by Chromium against the focused field, not reimplemented
 * over the clipboard API. The rejected renderer-side alternative and the rest of
 * the reasoning live in
 * `.agents/notes/implemented/bug-fix/2026-09-15-window-context-menu.md`.
 */

export type ContextMenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export type ContextMenuTemplateItem =
  | { readonly type: 'separator' }
  | { readonly role: ContextMenuRole; readonly label: string; readonly enabled: boolean }

export type ContextMenuLabels = Readonly<Record<ContextMenuRole, string>>

/** Structurally compatible with the fields this reads off `Electron.ContextMenuParams`. */
export type ContextMenuInput = {
  readonly isEditable: boolean
  readonly selectionText: string
  readonly mediaType: string
  readonly editFlags: {
    readonly canUndo: boolean
    readonly canRedo: boolean
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
    readonly canSelectAll: boolean
  }
}

/**
 * The menu for one right-click, or `[]` when the click has nothing to offer.
 * An empty template must draw no menu: a popup whose only entry is a disabled
 * Copy reads as broken, and blank space did nothing before this existed.
 */
export function buildContextMenuTemplate(
  params: ContextMenuInput,
  labels: ContextMenuLabels
): ContextMenuTemplateItem[] {
  // The image preview draws its own menu from the renderer, which holds the
  // only copy of the bytes (a `blob:` URL main cannot download). Two handlers
  // see the same click, so yielding here is what keeps one menu on screen.
  if (params.mediaType === 'image') {
    return []
  }

  const item = (role: ContextMenuRole, enabled: boolean): ContextMenuTemplateItem => ({
    role,
    label: labels[role],
    enabled
  })

  if (params.isEditable) {
    return [
      item('undo', params.editFlags.canUndo),
      item('redo', params.editFlags.canRedo),
      { type: 'separator' },
      item('cut', params.editFlags.canCut),
      item('copy', params.editFlags.canCopy),
      item('paste', params.editFlags.canPaste),
      { type: 'separator' },
      item('selectAll', params.editFlags.canSelectAll)
    ]
  }

  // Read-only content offers Copy alone. `selectAll` is deliberately absent:
  // outside a field Chromium selects the whole focused document, so in the app
  // shell it would sweep up the sidebar and every other panel with the
  // conversation rather than selecting "this".
  if (!params.selectionText.trim() || !params.editFlags.canCopy) {
    return []
  }
  return [item('copy', true)]
}
