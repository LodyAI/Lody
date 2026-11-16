import type { IpcServices } from '@/lib/electron-ipc-client';
import type { RecoveryPasskeys, RecoveryPort } from './recovery-port';

const passkeys = (state: RecoveryPasskeys): RecoveryPasskeys => ({
  passkeys: state.passkeys,
  pending: state.pending,
});

/** The desktop recovery port: main owns the file dialogs, bytes, passkey ceremony
 * and Argon2id password derivation, and answers with outcomes or `e2ee_recovery_*`
 * codes. Only the fields the port names are passed on. */
export function desktopRecoveryPort(e2ee: IpcServices['e2ee']): RecoveryPort {
  return {
    plan: async () => {
      const plan = await e2ee.recoveryReplacementPlan();
      return {
        hasVault: plan.hasVault,
        replacing: plan.replacing,
        ...(plan.methods ? { methods: plan.methods } : {}),
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
    createWithPasskey: async (label) => {
      const created = await e2ee.createRecoveryVault({
        method: 'passkey',
        ...(label ? { label } : {}),
      });
      return created.outcome === 'created'
        ? { outcome: 'created', vaultId: created.vaultId }
        : { outcome: 'cancelled' };
    },
    createWithPassword: async (password) => {
      const created = await e2ee.createRecoveryVault({ method: 'password', password });
      return created.outcome === 'created'
        ? { outcome: 'created', vaultId: created.vaultId }
        : { outcome: 'cancelled' };
    },
    saveFile: async (method, options) => {
      const saved = options
        ? await e2ee.saveRecoveryVaultFile(method, options)
        : await e2ee.saveRecoveryVaultFile(method);
      return saved.outcome === 'saved'
        ? { outcome: 'saved', vaultId: saved.vaultId }
        : { outcome: 'cancelled' };
    },
    setPassword: async (input) => {
      const updated = await e2ee.setRecoveryPassword(input);
      return updated.outcome === 'updated' ? { outcome: 'updated' } : { outcome: 'cancelled' };
    },
    removePassword: async (method, options) => {
      const removed = options
        ? await e2ee.removeRecoveryPassword(method, options)
        : await e2ee.removeRecoveryPassword(method);
      return removed.outcome === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: removed.outcome, pending: removed.pending };
    },
    restore: async (method, options) => {
      const restored = options
        ? await e2ee.restoreFromRecoveryFile(method, options)
        : await e2ee.restoreFromRecoveryFile(method);
      return restored.outcome === 'restored'
        ? {
            outcome: 'restored',
            results: restored.results.map((row) => ({
              ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId }),
              name: row.name,
              outcome: row.outcome,
            })),
          }
        : { outcome: 'cancelled' };
    },
    setupWorkspace: async (workspaceId, method, options) => {
      const done =
        method === undefined && options === undefined
          ? await e2ee.setupWorkspaceRecovery(workspaceId)
          : options === undefined
            ? await e2ee.setupWorkspaceRecovery(workspaceId, method)
            : await e2ee.setupWorkspaceRecovery(workspaceId, method ?? 'file', options);
      return 'recoverable' in done
        ? { outcome: done.outcome, recoverable: done.recoverable }
        : { outcome: 'cancelled' };
    },
    setupWorkspaces: async (workspaceIds, method, options) => {
      const settled = options
        ? await e2ee.setupRecoveryForWorkspaces(workspaceIds, method, options)
        : await e2ee.setupRecoveryForWorkspaces(workspaceIds, method);
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
    addPasskey: async (label, method, options) => {
      const added =
        method === undefined && options === undefined
          ? await e2ee.addRecoveryPasskey(label)
          : options === undefined
            ? await e2ee.addRecoveryPasskey(label, method)
            : await e2ee.addRecoveryPasskey(label, method ?? 'file', options);
      return added.outcome === 'added' ? { outcome: 'added' } : { outcome: 'cancelled' };
    },
    listPasskeys: async (method, options) => {
      const listed =
        method === undefined && options === undefined
          ? await e2ee.listRecoveryPasskeys()
          : options === undefined
            ? await e2ee.listRecoveryPasskeys(method)
            : await e2ee.listRecoveryPasskeys(method ?? 'file', options);
      return listed.outcome === 'listed'
        ? { outcome: 'listed', ...passkeys(listed) }
        : { outcome: 'cancelled' };
    },
    removePasskey: async (entryId, method, options) => {
      const removed =
        method === undefined && options === undefined
          ? await e2ee.removeRecoveryPasskey(entryId)
          : options === undefined
            ? await e2ee.removeRecoveryPasskey(entryId, method)
            : await e2ee.removeRecoveryPasskey(entryId, method ?? 'file', options);
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
