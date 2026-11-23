import './desktop-bootstrap'
import { app, dialog } from 'electron'
import { beginDesktopRunRecord } from './desktop-log'
import { isLocalPlatform, desktopInstallationProfile } from './platform'
import { extractDeepLinkFromArgv, parseDeepLinkArg } from './deep-link-url'
import { publishDeepLinkToPrimary, startDeepLinkIpcListener } from './deep-link-ipc'
import {
  acquireDesktopLease,
  CLOUD_DESKTOP_LOCK,
  handOffDesktopDeepLink
} from './services/desktop-exclusion'
import { createDesktopLaunchBuffer } from './services/desktop-launch-buffer'
import { createDesktopLaunchAdmission } from './services/desktop-launch-admission'
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
const launchAdmission = createDesktopLaunchAdmission((url) => launches.push({ url }))

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

async function forwardLaunchDeepLinks(): Promise<boolean> {
  const argvUrl = extractDeepLinkFromArgv(process.argv)
  const candidates = [
    ...launches.takePending().flatMap((event) => (event.url ? [event.url] : [])),
    ...(argvUrl ? [argvUrl] : [])
  ]
  let forwarded = false
  for (const url of new Set(candidates)) {
    if (await handOffDesktopDeepLink(url)) forwarded = true
  }
  return forwarded
}

async function start(): Promise<void> {
  // Same-app launches deliver their URL to the primary; they must not be
  // mistaken for a conflict with the other distribution.
  if (!isolatedE2E && !app.requestSingleInstanceLock()) {
    const url = extractDeepLinkFromArgv(process.argv)
    if (process.platform === 'win32' && url) publishDeepLinkToPrimary(url)
    app.quit()
    return
  }
  beginDesktopRunRecord()
  if (!isolatedE2E && process.platform === 'win32') {
    const stop = startDeepLinkIpcListener((url) => launches.push({ url }))
    app.once('will-quit', stop)
  }
  if (!isolatedE2E && !isLocalPlatform()) {
    const lease = await acquireDesktopLease(CLOUD_DESKTOP_LOCK, {
      onDeepLink: launchAdmission.accept
    })
    if (!lease) {
      await app.whenReady()
      // Opening lody:// may start this channel while another one owns the
      // desktop lease. Hand a portable destination to that installation, then
      // leave without loading credentials or showing a conflict the user cannot act on.
      if (await forwardLaunchDeepLinks()) {
        app.quit()
        return
      }
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
      launchAdmission.markRejected()
      await app.whenReady()
      await dialog.showMessageBox({
        type: 'info',
        title: desktopInstallationProfile.desktopProductName,
        ...describeDesktopHostConflict(result.record, result.accessDenied),
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
  launchAdmission.markReady()
}

void start().catch(async (error: unknown) => {
  launchAdmission.markRejected()
  console.error('[Electron] Desktop startup failed', error)
  await app.whenReady()
  dialog.showErrorBox(
    desktopInstallationProfile.desktopProductName,
    'Lody could not acquire its startup resources. Close other Lody applications and try again.'
  )
  app.exit(1)
})
