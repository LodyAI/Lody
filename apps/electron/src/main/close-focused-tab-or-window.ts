export type CloseableWindow = {
  close: () => void
  webContents: {
    isDevToolsOpened: () => boolean
    closeDevTools: () => void
  }
}

export function closeFocusedTabOrWindow({
  focused,
  mainWindow,
  sendCloseCurrentTabOrWindow
}: {
  focused: CloseableWindow | null
  mainWindow: CloseableWindow | null
  sendCloseCurrentTabOrWindow: () => void
}): void {
  if (!focused) return
  if (focused.webContents.isDevToolsOpened()) {
    focused.webContents.closeDevTools()
    return
  }
  if (mainWindow && focused === mainWindow) {
    sendCloseCurrentTabOrWindow()
    return
  }
  focused.close()
}
