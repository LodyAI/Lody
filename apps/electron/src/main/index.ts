import './desktop-bootstrap'
import { app, dialog } from 'electron'
import { isLocalPlatform, desktopInstallationProfile } from './platform'
import { extractDeepLinkFromArgv, parseDeepLinkArg } from './deep-link-url'
import { publishDeepLinkToPrimary, startDeepLinkIpcListener } from './deep-link-ipc'
import { acquireDesktopLease } from './services/desktop-exclusion'
import { createDesktopLaunchBuffer } from './services/desktop-launch-buffer'
import {
  acquireLocalCliHostLease,
  getLocalCliHostEndpoint
} from '@lody/shared/node/local-cli-host-lease'
import { randomUUID } from 'node:crypto'
import {
  borrowDesktopExecutionHost,
  describeDesktopHostConflict,
  type DesktopExecutionHost
} from './services/desktop-execution-host'

const isolatedE2E = !app.isPackaged && process.env.LODY_E2E === '1'
const launches = createDesktopLaunchBuffer()

// Listen synchronously, before ready or asynchronous ownership work. These
// handlers must not import a credential store or start an execution host.
app.on('open-url', (event, url) => {
  const parsed = parseDeepLinkArg(url)
  if (!parsed) return
  event.preventDefault()
  launches.push({ url: parsed })
})
app.on('second-instance', (_event, argv) => {
  launches.push({ url: extractDeepLinkFromArgv(argv) ?? undefined, activate: true })
})

async function start(): Promise<void> {
  // Same-app launches deliver their URL to the primary; they must not be
  // mistaken for a conflict with the other distribution.
  if (!isolatedE2E && !app.requestSingleInstanceLock()) {
    const url = extractDeepLinkFromArgv(process.argv)
    if (process.platform === 'win32' && url) publishDeepLinkToPrimary(url)
    app.quit()
    return
  }
  if (!isolatedE2E && process.platform === 'win32') {
    const stop = startDeepLinkIpcListener((url) => launches.push({ url }))
    app.once('will-quit', stop)
  }
  if (!isolatedE2E && !isLocalPlatform()) {
    const lease = await acquireDesktopLease()
    if (!lease) {
      await app.whenReady()
      await dialog.showMessageBox({
        type: 'info',
        title: desktopInstallationProfile.desktopProductName,
        message: 'Please quit the other Lody application first.',
        detail:
          'Lody and Lody Nightly cannot run together. Quit the running application and try again. ' +
          'If neither is running, another process may be using local port 17790.',
        buttons: ['OK']
      })
      app.quit()
      return
    }
  }
  let executionHost: DesktopExecutionHost | undefined
  if (!isolatedE2E && desktopInstallationProfile.releaseChannel === 'nightly') {
    // Reserve atomically, rather than inspecting and then racing the daemon
    // during auth/bootstrap. This lease lasts through Worker restarts/toggles.
    const result = await acquireLocalCliHostLease({
      endpoint: getLocalCliHostEndpoint(desktopInstallationProfile.platform),
      instanceId: randomUUID(),
      mode: 'electron'
    })
    if (result.status === 'occupied') {
      await app.whenReady()
      await dialog.showMessageBox({
        type: 'info',
        title: desktopInstallationProfile.desktopProductName,
        ...describeDesktopHostConflict(result.record),
        buttons: ['OK']
      })
      app.quit()
      return
    }
    executionHost = borrowDesktopExecutionHost(result.lease)
  }
  // Auth/settings modules open stores at evaluation. Keep this import lazy.
  const application = await import('./application')
  application.startApplication(executionHost)
  launches.bind(application.handleDesktopLaunch)
}

void start().catch(async (error: unknown) => {
  console.error('[Electron] Desktop startup failed', error)
  await app.whenReady()
  dialog.showErrorBox(
    desktopInstallationProfile.desktopProductName,
    'Lody could not acquire its startup resources. Close other Lody applications and try again.'
  )
  app.exit(1)
})
