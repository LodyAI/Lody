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
  const choosers = new AbortController();
  const choose = () => chooseRecoveryFile({ signal: choosers.signal });
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
    chooseFile: options.chooseFile ?? choose,
    defaultLabel: config.defaultLabel,
    saveFile: async (file) => {
      check();
      const exportFile =
        options.exportFile ?? (await import('./recovery-file')).exportMobileRecoveryFile;
      if (!(await exportFile(file, check))) return null;
      check();
      const read = await (options.confirmSavedFile ?? options.chooseFile ?? choose)();
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
      choosers.abort();
      loaded?.dispose();
    },
  };
}

export type SavedFilePromptState = 'closed' | 'waiting' | 'choosing';

/**
 * The fresh-tap prompt that re-reads a just-exported file inside the creation command. The
 * prompt stays open while its chooser runs: WKWebView may close the picker without any
 * event, so Cancel must still release the command and Choose again replaces the chooser.
 * A dismissed chooser returns to `waiting`; only a file, an error or Cancel answers.
 */
export function savedFilePrompt(
  onState: (state: SavedFilePromptState) => void,
  choose: typeof chooseRecoveryFile = chooseRecoveryFile
) {
  let answer:
    | { resolve: (file: Uint8Array | null) => void; reject: (error: unknown) => void }
    | undefined;
  let picking: AbortController | undefined;
  let disposed = false;
  const settle = (reply: (to: NonNullable<typeof answer>) => void) => {
    const to = answer;
    answer = undefined;
    picking?.abort();
    picking = undefined;
    onState('closed');
    if (to) reply(to);
  };
  return {
    request: () =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        settle((to) => to.resolve(null));
        if (disposed) return resolve(null);
        answer = { resolve, reject };
        onState('waiting');
      }),
    pick: () => {
      if (!answer) return;
      picking?.abort();
      const controller = new AbortController();
      picking = controller;
      onState('choosing');
      choose({ signal: controller.signal }).then(
        (file) => {
          if (picking !== controller) return file?.fill(0);
          picking = undefined;
          if (file) settle((to) => to.resolve(file));
          else onState('waiting');
        },
        (error: unknown) => {
          if (picking !== controller) return;
          picking = undefined;
          settle((to) => to.reject(error));
        }
      );
    },
    cancel: () => settle((to) => to.resolve(null)),
    dispose: () => {
      disposed = true;
      settle((to) => to.resolve(null));
    },
  };
}
