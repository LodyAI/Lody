import { app, BrowserWindow, ipcMain, MessageChannelMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSocketTransport, readEngineEndpoint } from '@loro-dev/loro-repo-client/node'
import { engineVersion } from '@loro-dev/loro-repo-engine'

const directory = dirname(fileURLToPath(import.meta.url))
// Proves the staged addon also loads under Electron from app.asar + unpacked.
globalThis.repoLabNativeVersion = engineVersion()
app.setPath('userData', process.env.LODY_REPO_LAB_PROFILE)
const windows = new Set()
const bridges = new Set()

// The generic bridge is restricted to these isolated synthetic windows. It must
// never be installed on a product window: the socket grants the full SDK API.
ipcMain.on('repo-lab:connect', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!windows.has(window) || event.senderFrame !== event.sender.mainFrame) return
  let transport
  try {
    const endpoint = await readEngineEndpoint(process.env.LODY_REPO_LAB_DATA)
    transport = await connectSocketTransport(endpoint.socket)
    if (window.isDestroyed()) {
      await transport.close()
      return
    }
    const { port1, port2 } = new MessageChannelMain()
    let closed = false
    let offMessage = () => {}
    let offClose = () => {}
    const close = () => {
      if (closed) return
      closed = true
      bridges.delete(close)
      window.webContents.removeListener('did-start-navigation', close)
      window.removeListener('closed', close)
      offMessage()
      offClose()
      port1.postMessage({ type: 'closed' })
      port1.close()
      void transport.close().catch(() => {})
    }
    bridges.add(close)
    offMessage = transport.onMessage((text) => port1.postMessage(text))
    offClose = transport.onClose(close)
    port1.on('message', ({ data }) => {
      if (closed || typeof data !== 'string') return
      try {
        transport.send(data)
      } catch {
        close()
      }
    })
    port1.on('close', close)
    window.webContents.once('did-start-navigation', close)
    window.once('closed', close)
    port1.start()
    event.sender.postMessage('repo-lab:port', null, [port2])
  } catch {
    await transport?.close().catch(() => {})
    if (!event.sender.isDestroyed())
      event.sender.send('repo-lab:connect-error', 'engine_unavailable')
  }
})

void app
  .whenReady()
  .then(async () => {
    for (let index = 0; index < 2; index++) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: join(directory, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      })
      windows.add(window)
      window.once('closed', () => windows.delete(window))
      await window.loadFile(join(directory, 'index.html'))
    }
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
app.on('before-quit', () => {
  for (const close of [...bridges]) close()
})
app.on('window-all-closed', () => app.quit())
