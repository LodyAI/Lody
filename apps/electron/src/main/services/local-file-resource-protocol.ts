import { protocol, session } from 'electron'
import { LocalFileResources } from './local-file-resource'
import {
  HTML_PREVIEW_SCHEME,
  isHtmlPreviewPermissionRequester,
  LocalHtmlPreviewSites
} from './local-html-preview'

export const localFileResources = new LocalFileResources()
export const localHtmlPreviewSites = new LocalHtmlPreviewSites()

export function registerLocalFileResourceScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'lody-resource',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    },
    {
      // Standard + secure gives every preview token its own origin, so relative
      // URLs resolve and the page can never be same-origin with the renderer.
      scheme: HTML_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
}

export function installLocalFileResourceProtocol() {
  protocol.handle('lody-resource', (request) => localFileResources.respond(request))
  protocol.handle(HTML_PREVIEW_SCHEME, (request) => localHtmlPreviewSites.respond(request))
  denyHtmlPreviewPermissions()
}

/**
 * Product windows use the default session, whose Electron default grants every
 * permission. Preview pages are untrusted local content, so they get none; every
 * other requester keeps that default answer.
 */
function denyHtmlPreviewPermissions() {
  const defaultSession = session.defaultSession
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback, details) => {
    const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined
    callback(!isHtmlPreviewPermissionRequester(details.requestingUrl, securityOrigin))
  })
  defaultSession.setPermissionCheckHandler(
    (_webContents, _permission, requestingOrigin, details) =>
      !isHtmlPreviewPermissionRequester(
        requestingOrigin,
        details.requestingUrl,
        details.securityOrigin,
        details.embeddingOrigin
      )
  )
}
