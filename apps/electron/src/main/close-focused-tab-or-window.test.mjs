import assert from 'node:assert/strict'
import test from 'node:test'
import { closeFocusedTabOrWindow } from './close-focused-tab-or-window.ts'

function fakeWindow({ devToolsOpen = false } = {}) {
  const window = {
    closed: false,
    closedDevTools: false,
    close() {
      window.closed = true
    },
    webContents: {
      isDevToolsOpened: () => devToolsOpen,
      closeDevTools() {
        window.closedDevTools = true
      }
    }
  }
  return window
}

void test('closes DevTools before asking the renderer or the window', () => {
  const focused = fakeWindow({ devToolsOpen: true })
  closeFocusedTabOrWindow({
    focused,
    mainWindow: focused,
    sendCloseCurrentTabOrWindow: () => {
      throw new Error('should not reach renderer')
    }
  })
  assert.equal(focused.closedDevTools, true)
  assert.equal(focused.closed, false)
})

void test('broadcasts to the renderer when the main window is focused', () => {
  const main = fakeWindow()
  let sent = 0
  closeFocusedTabOrWindow({
    focused: main,
    mainWindow: main,
    sendCloseCurrentTabOrWindow: () => {
      sent += 1
    }
  })
  assert.equal(sent, 1)
  assert.equal(main.closed, false)
})

void test('closes a non-main window directly', () => {
  const main = fakeWindow()
  const other = fakeWindow()
  closeFocusedTabOrWindow({
    focused: other,
    mainWindow: main,
    sendCloseCurrentTabOrWindow: () => {
      throw new Error('should not reach renderer')
    }
  })
  assert.equal(other.closed, true)
  assert.equal(main.closed, false)
})

void test('is a no-op without a focused window', () => {
  const main = fakeWindow()
  closeFocusedTabOrWindow({
    focused: null,
    mainWindow: main,
    sendCloseCurrentTabOrWindow: () => {
      throw new Error('should not reach renderer')
    }
  })
  assert.equal(main.closed, false)
})
