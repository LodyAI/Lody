import { personalEntryRecovery, type PersonalEntryRecovery } from '@lody/client-e2ee';
import { chooseRecoveryFile, recoveryWorkspacesPort } from '@lody/client-e2ee/recovery-port';
import type { MobileRecoveryConfig } from './recovery-context';
import type { MobileRecoveryWorkspaces } from '../e2ee/recovery';

/**
 * The console's recovery port for one login. The vault engine and its cryptography load
 * only on first use; commands borrow the application's existing encrypted runtime.
 */
export function mobileRecoveryPort(options: {
  readonly config: MobileRecoveryConfig;
  readonly accountId: string;
  readonly sessionId: string;
  readonly currentSession: () => { accountId: string; sessionId: string } | null;
  /** Owning tests inject a file source; the product opens the system chooser. */
  readonly chooseFile?: () => Promise<Uint8Array | null>;
  /** The provider asks for a fresh tap before opening WebKit's verification picker. */
  readonly confirmSavedFile?: () => Promise<Uint8Array | null>;
  readonly exportFile?: (file: Uint8Array, check: () => void) => Promise<boolean>;
}) {
  const { config } = options;
  let loaded: MobileRecoveryWorkspaces | undefined;
  let engine: Promise<MobileRecoveryWorkspaces> | undefined;
  let disposed = false;
  const check = () => {
    const current = options.currentSession();
    if (
      disposed ||
      !config.enabled() ||
      current?.accountId !== options.accountId ||
      current.sessionId !== options.sessionId
    )
      throw new Error('e2ee_recovery_cancelled');
  };
  const commands = (): PersonalEntryRecovery => {
    const owner = config.runtime();
    const recovery = owner && personalEntryRecovery(owner);
    if (!recovery) throw new Error('e2ee_recovery_not_ready');
    return recovery;
  };
  // Typed against the public RecoveryPort where the host provider supplies it.
  const port = recoveryWorkspacesPort({
    engine: () =>
      (engine ??= import('../e2ee/recovery').then(({ makeMobileRecoveryWorkspaces }) => {
        loaded = makeMobileRecoveryWorkspaces({
          accountId: options.accountId,
          sessionId: options.sessionId,
          currentSession: options.currentSession,
          enabled: config.enabled,
          client: config.client,
          passkey: config.passkey,
          commands: {
            restore: (...args) => commands().restore(...args),
            setup: (...args) => commands().setup(...args),
          },
        });
        // A late load after logout refuses every command.
        if (disposed) loaded.dispose();
        return loaded;
      })),
    run: config.run,
    chooseFile: options.chooseFile ?? chooseRecoveryFile,
    defaultLabel: config.defaultLabel,
    saveFile: async (file) => {
      check();
      const exportFile =
        options.exportFile ?? (await import('./recovery-file')).exportMobileRecoveryFile;
      if (!(await exportFile(file, check))) return null;
      check();
      const read = await (options.confirmSavedFile ?? options.chooseFile ?? chooseRecoveryFile)();
      try {
        check();
        return read;
      } catch (error) {
        read?.fill(0);
        throw error;
      }
    },
  });
  return {
    port,
    dispose: () => {
      disposed = true;
      loaded?.dispose();
    },
  };
}
