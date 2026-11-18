const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('repoLab', {
  connect: () => ipcRenderer.send('repo-lab:connect')
})
ipcRenderer.on('repo-lab:port', (event) => {
  window.postMessage({ type: 'repo-lab:port' }, '*', event.ports)
})
ipcRenderer.on('repo-lab:connect-error', (_event, code) => {
  window.postMessage({ type: 'repo-lab:connect-error', code }, '*')
})
