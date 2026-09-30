import { protocol } from 'electron'
import { LocalFileResources } from './local-file-resource'
import { MCP_APP_SANDBOX_SCHEME, respondMcpAppSandbox } from './mcp-app-sandbox'

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
    },
    // Electron accepts one privileged-scheme registration, so every custom scheme lives here.
    { scheme: MCP_APP_SANDBOX_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

export function installLocalFileResourceProtocol() {
  protocol.handle('lody-resource', (request) => localFileResources.respond(request))
  protocol.handle(MCP_APP_SANDBOX_SCHEME, respondMcpAppSandbox)
}
