import { BackendError } from '@lody/e2ee-core/services'

/** Only the authenticated device endpoint can classify a removed member. */
export class E2eeMemberRemovedError extends BackendError {
  constructor() {
    super({ service: 'E2eeCloud', reason: 'unauthorized' })
  }
}

/** Only the authenticated device endpoint can classify this device's revocation.
 * Other unauthorized results stay ordinary failures and never authorize deletion. */
export class E2eeDeviceRevokedError extends BackendError {
  constructor() {
    super({ service: 'E2eeCloud', reason: 'unauthorized' })
  }
}
