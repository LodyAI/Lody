import type {
  E2eeWorkspacePrepared,
  E2eeWorkspacePrepareInput,
  PlatformE2eeWorkspaces,
  PlatformSessionState,
} from '@lody/platform';

/** Local authentication hydration can recover without changing the account ID. */
export class E2eeAccountUnavailableError extends Error {
  constructor() {
    super('e2ee_account_unavailable');
  }
}

/** The server describes a mode or activation newer than this client implements.
 * Fails closed like any unknown mode, but tells the user to update instead of
 * reporting a damaged workspace. */
export class E2eeClientUpgradeRequiredError extends Error {
  constructor() {
    super('e2ee_client_upgrade_required');
    this.name = 'E2eeClientUpgradeRequiredError';
  }
}

/** Bind the native creation intent and cloud receipt to the same live account.
 * Raw network calls retain ownership until settlement; a logout only invalidates
 * their UI result. It never deletes a potentially committed local key or intent.
 */
export function createCloudE2eeWorkspaces(input: {
  session: () => PlatformSessionState;
  remote: Pick<PlatformE2eeWorkspaces, 'create' | 'describe' | 'history'>;
  prepareCreation?: PlatformE2eeWorkspaces['prepareCreation'];
  runtime?: PlatformE2eeWorkspaces['runtime'];
  refreshWorkspaces: () => Promise<void>;
}): PlatformE2eeWorkspaces {
  const prepared = new Map<string, E2eeWorkspacePrepared>();
  const prepareCreation = input.prepareCreation;
  const account = () => {
    const session = input.session();
    if (session.status !== 'authenticated') throw new E2eeAccountUnavailableError();
    return session.user.id;
  };
  const assertAccount = (owner: string) => {
    if (account() !== owner) throw new Error('e2ee_account_changed');
  };
  const intentKey = (owner: string, requestId: string) => JSON.stringify([owner, requestId]);

  return {
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(prepareCreation
      ? {
          prepareCreation: async (request: E2eeWorkspacePrepareInput) => {
            const owner = account();
            if (request.accountId !== owner) throw new Error('e2ee_account_changed');
            const captured = { ...request };
            const result = await prepareCreation(captured);
            assertAccount(owner);
            if (
              result.accountId !== owner ||
              result.requestId !== captured.requestId ||
              result.name !== captured.name ||
              result.slug !== captured.slug
            ) {
              throw new Error('e2ee_preparation_mismatch');
            }
            prepared.set(intentKey(owner, captured.requestId), { ...result });
            return { ...result };
          },
        }
      : {}),
    create: async (request) => {
      const owner = account();
      const original = prepared.get(intentKey(owner, request.requestId));
      if (
        !original ||
        request.accountId !== owner ||
        request.developerMode !== true ||
        request.name !== original.name ||
        request.slug !== original.slug ||
        request.genesisRecordHex !== original.genesisRecordHex ||
        request.deviceCredentialHash !== original.deviceCredentialHash
      ) {
        throw new Error('e2ee_preparation_required');
      }
      const result = await input.remote.create({ ...request });
      assertAccount(owner);
      if (
        result.contentMode !== 'e2ee' ||
        result.contentModeVersion !== 1 ||
        result.activation !== 'control-only' ||
        result.genesisHash !== original.genesisHashHex ||
        result.cryptoOrgId !== original.genesisHashHex ||
        result.name !== original.name ||
        result.slug !== original.slug ||
        !result.workspaceId
      ) {
        throw new Error('e2ee_creation_receipt_mismatch');
      }
      if (input.runtime) {
        try {
          await input.runtime.recordCreated({
            workspaceId: result.workspaceId,
            genesisHash: original.genesisHashHex,
            requestId: original.requestId,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            /e2ee_(?:conflict|local-evidence-conflict|account_mismatch)/.test(error.message)
          )
            throw error;
          console.warn('Encrypted workspace local binding pending', {
            code: 'e2ee_binding_pending',
          });
        }
        assertAccount(owner);
      }
      // Listing is a projection: its failure must not turn a committed, validated
      // creation into an error. The next listing refresh shows the workspace.
      try {
        await input.refreshWorkspaces();
      } catch {
        console.warn('Encrypted workspace list refresh pending', { code: 'e2ee_listing_pending' });
      }
      assertAccount(owner);
      return result;
    },
    describe: async (request) => {
      const owner = account();
      const workspaceId = request.workspaceId;
      const result = await input.remote.describe({ workspaceId });
      assertAccount(owner);
      if (result.workspaceId !== workspaceId) {
        throw new Error('e2ee_workspace_mode_unavailable');
      }
      if ('admission' in result) {
        if (
          result.admission !== 'legacy-unclassified' ||
          ['contentMode', 'contentModeVersion', 'genesisHash', 'cryptoOrgId'].some(
            (field) => field in result
          )
        ) {
          throw new Error('e2ee_workspace_mode_unavailable');
        }
        return { workspaceId, admission: 'legacy-unclassified' };
      }
      const reported = result as { contentModeVersion?: unknown; activation?: unknown };
      if (
        (typeof reported.contentModeVersion === 'number' && reported.contentModeVersion > 1) ||
        (result.contentMode === 'e2ee' &&
          result.contentModeVersion === 1 &&
          typeof reported.activation === 'string' &&
          reported.activation !== 'control-only')
      )
        throw new E2eeClientUpgradeRequiredError();
      if (
        result.contentModeVersion !== 1 ||
        (result.contentMode !== 'plaintext' && result.contentMode !== 'e2ee') ||
        (result.contentMode === 'e2ee' &&
          (result.activation !== 'control-only' ||
            !/^[0-9a-f]{64}$/.test(result.genesisHash) ||
            result.cryptoOrgId !== result.genesisHash)) ||
        (result.contentMode === 'plaintext' && ('genesisHash' in result || 'cryptoOrgId' in result))
      ) {
        throw new Error('e2ee_workspace_mode_unavailable');
      }
      return result;
    },
    history: async (request) => {
      const owner = account();
      const workspaceId = request.workspaceId;
      const result = await input.remote.history({
        ...request,
        ...(request.checkpoint ? { checkpoint: { ...request.checkpoint } } : {}),
      });
      assertAccount(owner);
      if (result.workspaceId !== workspaceId) throw new Error('e2ee_history_scope_mismatch');
      return result;
    },
  };
}
