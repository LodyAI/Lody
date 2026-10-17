import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { Effect } from 'effect'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import { makeElectronE2eeCustody } from '../../e2ee-custody-electron'
import { isLocalPlatform } from '../../platform'
import {
  makeDesktopE2eeBootstrap,
  validateDesktopE2eeCreationIntent,
  type DesktopE2eeCreationIntent
} from '../../services/e2ee-bootstrap.mjs'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

/** Narrow host operation: local creation/reopen only, never arbitrary signing or key export. */
export class E2eeIpc extends IpcService {
  static override readonly groupName = 'e2ee'

  @IpcMethod()
  async prepareCreation(payload: DesktopE2eeCreationIntent) {
    assertProductWindowSender(getIpcContext().event)
    // Reject before any authenticated request or native-keychain access in OSS mode.
    if (isLocalPlatform()) throw new Error('Encrypted cloud workspace creation is unavailable')
    validateDesktopE2eeCreationIntent(payload)
    const intent = Object.freeze({ ...payload })
    const session = await getIpcServiceDeps().authService.getBootstrapSession()
    if (!session?.userId || session.userId !== intent.accountId) {
      throw new Error('Encrypted workspace creation account mismatch')
    }
    const accountDirectory = createHash('sha256').update(intent.accountId).digest('hex')
    const directory = join(app.getPath('userData'), 'e2ee-bootstrap', accountDirectory)
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const custody = yield* makeElectronE2eeCustody(join(directory, 'custody'))
          const bootstrap = yield* makeDesktopE2eeBootstrap({
            directory,
            accountId: intent.accountId,
            custody
          })
          return yield* bootstrap.prepareCreation(intent)
        })
      )
    )
  }
}
