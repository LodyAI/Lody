import type { IpcServices } from '@/lib/electron-ipc-client';
import type { RecoveryPasskeys, RecoveryPort } from './recovery-port';

const passkeys = (state: RecoveryPasskeys): RecoveryPasskeys => ({
  passkeys: state.passkeys,
  pending: state.pending,
});

/** The desktop recovery port: main owns the file dialogs, bytes and passkey ceremony
 * and answers with outcomes or `e2ee_recovery_*` codes. Only the fields the port
 * names are passed on. */
export function desktopRecoveryPort(e2ee: IpcServices['e2ee']): RecoveryPort {
  return {
    plan: async () => {
      const plan = await e2ee.recoveryReplacementPlan();
      return {
        hasVault: plan.hasVault,
        replacing: plan.replacing,
        covered: plan.covered,
        uncovered: plan.uncovered,
      };
    },
    securityEvents: () => e2ee.recentAccountSecurityEvents(),
    passkeyAvailable: () => e2ee.recoveryPasskeyAvailable(),
    create: async () => {
      const created = await e2ee.createRecoveryVault();
      return created.outcome === 'created'
        ? { outcome: 'created', vaultId: created.vaultId }
        : { outcome: 'cancelled' };
    },
    restore: async (method) => {
      const restored = await e2ee.restoreFromRecoveryFile(method);
      return restored.outcome === 'restored'
        ? {
            outcome: 'restored',
            results: restored.results.map((row) => ({ name: row.name, outcome: row.outcome })),
          }
        : { outcome: 'cancelled' };
    },
    setupWorkspace: async (workspaceId) => {
      const done = await e2ee.setupWorkspaceRecovery(workspaceId);
      return 'recoverable' in done
        ? { outcome: done.outcome, recoverable: done.recoverable }
        : { outcome: 'cancelled' };
    },
    setupWorkspaces: async (workspaceIds, method) => {
      const settled = await e2ee.setupRecoveryForWorkspaces(workspaceIds, method);
      return settled.outcome === 'settled'
        ? {
            outcome: 'settled',
            results: settled.results.map((row) => ({
              workspaceId: row.workspaceId,
              outcome: row.outcome,
              recoverable: row.recoverable,
            })),
          }
        : { outcome: 'cancelled' };
    },
    passkeyDefaultLabel: () => e2ee.recoveryPasskeyDefaultLabel(),
    addPasskey: async (label) => {
      const added = await e2ee.addRecoveryPasskey(label);
      return added.outcome === 'added' ? { outcome: 'added' } : { outcome: 'cancelled' };
    },
    listPasskeys: async () => {
      const listed = await e2ee.listRecoveryPasskeys();
      return listed.outcome === 'listed'
        ? { outcome: 'listed', ...passkeys(listed) }
        : { outcome: 'cancelled' };
    },
    removePasskey: async (entryId) => {
      const removed = await e2ee.removeRecoveryPasskey(entryId);
      return removed.outcome === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: removed.outcome, ...passkeys(removed) };
    },
    checkFile: async () => {
      const opened = await e2ee.inspectRecoveryFile();
      return opened.outcome === 'opened'
        ? { outcome: 'opened', vaultId: opened.vaultId, workspaces: opened.workspaces }
        : { outcome: 'cancelled' };
    },
    replacement: {
      begin: async () => {
        const begun = await e2ee.beginRecoveryReplacement();
        return begun.outcome === 'begun' ? { outcome: 'begun' } : { outcome: 'cancelled' };
      },
      finish: async ({ compromised }) => {
        const finished = await e2ee.continueRecoveryReplacement({ compromised });
        return { outcome: finished.outcome };
      },
      abandon: async () => {
        const abandoned = await e2ee.abandonRecoveryReplacement();
        return { outcome: abandoned.outcome };
      },
    },
  };
}
