import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { z } from 'zod'
import { automationSettingsSchema } from '@lody/shared/automations'
import { assertProductWindowSender } from '../assert-sender'
import { IPC_PUSH_CHANNELS, type SessionControlSendInput } from '@lody/shared/electron-ipc'
import type { LocalSessionControlRequest } from '@lody/shared/message'
import { getIpcServiceDeps } from '../ipc-service-deps'

const identity = z.string().min(1).max(512)
const automationInput = z
  .object({
    workspaceId: identity,
    machineId: identity,
    sessionId: identity,
    command: z.discriminatedUnion('type', [
      z.object({ type: z.literal('list') }).strict(),
      z.object({ type: z.literal('settings') }).strict(),
      z.object({ type: z.literal('configure'), settings: automationSettingsSchema }).strict(),
      z.object({ type: z.literal('cancel'), id: identity }).strict()
    ])
  })
  .strict()

const publicWait = z.object({
  id: identity,
  sessionId: identity,
  reason: z.string().optional(),
  state: z.enum(['waiting', 'checking', 'matched', 'cancelled', 'expired', 'failed']),
  nextCheckAt: z.number(),
  expiresAt: z.number().optional(),
  continuation: z.object({ state: z.string(), reason: z.string().optional() }).optional()
})

export class SessionControlIpc extends IpcService {
  static override readonly groupName = 'sessionControl'

  @IpcMethod()
  async automation(input: z.infer<typeof automationInput>) {
    assertProductWindowSender(getIpcContext().event)
    const { workspaceId, machineId, sessionId, command } = automationInput.parse(input)
    const cli = getIpcServiceDeps().cliService
    if (machineId !== (await cli.getLocalMachineId()))
      throw new Error('automation_machine_unavailable')
    const send = async (command: import('@lody/shared/automations').AutomationCommand) => {
      const response = await cli.sendLocalAutomationControl({ workspaceId, machineId, command })
      if (!response.ok) throw new Error(response.error)
      return response.result
    }
    if (command.type === 'list') {
      const waits = z.array(publicWait).parse(await send({ type: 'list', sessionId }))
      if (waits.some((wait) => wait.sessionId !== sessionId))
        throw new Error('automation_scope_mismatch')
      return { type: 'list' as const, waits }
    }
    if (command.type === 'cancel') {
      const waits = z.array(publicWait).parse(await send({ type: 'list', sessionId }))
      if (!waits.some((wait) => wait.id === command.id && wait.sessionId === sessionId))
        throw new Error('automation_not_found')
      await send({ type: 'cancel', id: command.id })
      return { type: 'cancel' as const }
    }
    const result = await send(
      command.type === 'settings'
        ? { type: 'settings', sessionId }
        : { type: 'configure', sessionId, settings: command.settings }
    )
    return { type: 'settings' as const, settings: automationSettingsSchema.parse(result) }
  }

  @IpcMethod()
  async send(payload: SessionControlSendInput) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false as const, error: 'invalid_request' }
    }
    const { requestId, message } = payload
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return { ok: false as const, error: 'invalid_request' }
    }
    const { event } = getIpcContext()
    return await getIpcServiceDeps().cliService.sendLocalSessionControl(
      message as LocalSessionControlRequest,
      {
        onResponse: (response) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IPC_PUSH_CHANNELS.sessionControlResponse, {
            requestId,
            response
          })
        }
      }
    )
  }
}
