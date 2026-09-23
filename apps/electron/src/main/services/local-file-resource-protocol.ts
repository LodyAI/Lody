import { protocol } from 'electron'
import { LocalFileResources } from './local-file-resource'

export const localFileResources = new LocalFileResources()

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
    }
  ])
}

export function installLocalFileResourceProtocol() {
  protocol.handle('lody-resource', (request) => localFileResources.respond(request))
}
