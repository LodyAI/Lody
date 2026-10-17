import { ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS } from '@lody/shared/acp-startup-budget'
import type { LocalSessionControlRequest } from '@lody/shared/message'

const REQUEST_TIMEOUT_MS = 10_000
const BINARY_INSTALL_TIMEOUT_MS = 300_000
const FILE_SEND_TIMEOUT_MS = 120_000

/** A parked watch still needs the ordinary read budget after its wait ends. */
export function resolveLocalSessionControlTimeoutMs(message: LocalSessionControlRequest): number {
  switch (message.type) {
    case 'session/history-read':
      return message.query.kind === 'watchChanges'
        ? message.query.waitMs + REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS
    case 'machine/acp-capabilities-refresh':
      return ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS
    case 'machine/acp-authenticate':
    case 'machine/acp-binary-install':
      return BINARY_INSTALL_TIMEOUT_MS
    case 'session/file-send-local':
      return FILE_SEND_TIMEOUT_MS
    default:
      return REQUEST_TIMEOUT_MS
  }
}
