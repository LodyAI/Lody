import { personalEntryRecovery, type PersonalEntryRecovery } from '@lody/client-e2ee';
import { chooseRecoveryFile, recoveryWorkspacesPort } from '@lody/client-e2ee/recovery-port';
import type { MobileRecoveryConfig } from './recovery-context';
import type { MobileRecoveryWorkspaces } from '../e2ee/recovery';

/** The prompt around a file action's chooser (`open`) or saved-file verification (`verify`). */
export type FilePromptMode = 'open' | 'verify';
type PromptState =
  | { readonly tag: 'idle' }
  | { readonly tag: 'disposed' }
  | {
      readonly tag: 'active';
      readonly mode: FilePromptMode;
      readonly picker: AbortController | null;
      readonly resolve: (file: Uint8Array | null) => void;
      readonly reject: (error: unknown) => void;
    };

/**
 * The console's recovery port for one login. The vault engine and its cryptography load
 * only on first use; commands borrow the application's existing encrypted runtime.
 * Every system chooser runs under the host's file prompt: WKWebView may close its picker
 * without any event, so the prompt stays open with Cancel and the reopening button while
 * a chooser runs, and Cancel releases the command waiting on it.
 */
export function mobileRecoveryPort(options: {
  readonly config: MobileRecoveryConfig;
  readonly accountId: string;
  readonly sessionId: string;
  readonly currentSession: () => { accountId: string; sessionId: string } | null;
  /** Owning tests inject a file source; the product opens the system chooser. */
  readonly chooseFile?: () => Promise<Uint8Array | null>;
  readonly onFilePrompt?: (mode: FilePromptMode | null) => void;
  readonly exportFile?: (file: Uint8Array, check: () => void) => Promise<boolean>;
}) {
  const { config } = options;
  let loaded: MobileRecoveryWorkspaces | undefined;
  let engine: Promise<MobileRecoveryWorkspaces> | undefined;
  let disposed = false;
  let prompt: PromptState = { tag: 'idle' };
  const publish = () => options.onFilePrompt?.(prompt.tag === 'active' ? prompt.mode : null);
  const answer = (reply: (active: Extract<PromptState, { tag: 'active' }>) => void) => {
    if (prompt.tag !== 'active') return;
    const active = prompt;
    active.picker?.abort();
    prompt = { tag: 'idle' };
    publish();
    reply(active);
  };
  /** Opens (or reopens) the system chooser; call it synchronously from the tap. */
  const pick = () => {
    if (prompt.tag !== 'active') return;
    prompt.picker?.abort();
    const picker = new AbortController();
    prompt = { ...prompt, picker };
    chooseRecoveryFile({ signal: picker.signal }).then(
      (file) => {
        if (prompt.tag !== 'active' || prompt.picker !== picker) return void file?.fill(0);
        if (file || prompt.mode === 'open') answer((active) => active.resolve(file));
        else prompt = { ...prompt, picker: null };
      },
      (error: unknown) => {
        if (prompt.tag === 'active' && prompt.picker === picker)
          answer((active) => active.reject(error));
      }
    );
  };
  const ask = (mode: FilePromptMode) =>
    new Promise<Uint8Array | null>((resolve, reject) => {
      answer((active) => active.resolve(null));
      if (prompt.tag === 'disposed') return resolve(null);
      prompt = { tag: 'active', mode, picker: null, resolve, reject };
      publish();
      if (mode === 'open') pick();
    });
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
    chooseFile: options.chooseFile ?? (() => ask('open')),
    defaultLabel: config.defaultLabel,
    saveFile: async (file) => {
      check();
      const exportFile =
        options.exportFile ?? (await import('./recovery-file')).exportMobileRecoveryFile;
      if (!(await exportFile(file, check))) return null;
      check();
      const read = await (options.chooseFile ?? (() => ask('verify')))();
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
    filePrompt: { pick, cancel: () => answer((active) => active.resolve(null)) },
    dispose: () => {
      disposed = true;
      answer((active) => active.resolve(null));
      prompt = { tag: 'disposed' };
      loaded?.dispose();
    },
  };
}
