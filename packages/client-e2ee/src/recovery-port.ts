import { Effect } from 'effect';
import type { ClientRecoveryUnlock } from './recovery';
import type {
  RecoveryWorkspaceProgress,
  RecoveryWorkspaceResult,
  makeRecoveryWorkspaces,
} from './recovery-workspaces';

type Engine = ReturnType<typeof makeRecoveryWorkspaces>;
type Method = 'file' | 'passkey' | 'password';
type UnlockOptions = { readonly password?: string };
const cancelled = { outcome: 'cancelled' } as const;

export type RecoveryWorkspacesPortHost = {
  /** The engine bound to the current login. Called only after a file prompt has opened,
   * so a host may load it lazily. Disposal stays with the host. */
  readonly engine: () => Promise<Engine>;
  readonly run: <A>(program: Effect.Effect<A, unknown>) => Promise<A>;
  /** Opens the platform's file chooser and resolves null when dismissed. It is called
   * synchronously at the start of a file action, so the user's tap still activates it. */
  readonly chooseFile: () => Promise<Uint8Array | null>;
  readonly defaultLabel: () => Promise<string>;
  /** Hosts that can save a file: write the new recovery file where the person chooses,
   * then return the file they pick again (null when they cancel). Absent: no creation. */
  readonly saveFile?: (file: Uint8Array) => Promise<Uint8Array | null>;
};

/** Recovery files are at most 4 KiB; anything larger is refused before it is read. */
const fileLimit = 4096;

/** A one-shot file chooser. Resolves null when the person dismisses it. */
export function chooseRecoveryFile(): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    const done = () => input.remove();
    input.addEventListener(
      'change',
      () => {
        done();
        const chosen = input.files?.[0];
        if (!chosen) return resolve(null);
        if (chosen.size < 1 || chosen.size > fileLimit)
          return reject(new Error('e2ee_recovery_invalid-input'));
        chosen.arrayBuffer().then(
          (buffer) => resolve(new Uint8Array(buffer)),
          () => reject(new Error('e2ee_recovery_invalid-input'))
        );
      },
      { once: true }
    );
    input.addEventListener(
      'cancel',
      () => {
        done();
        resolve(null);
      },
      { once: true }
    );
    document.body.append(input);
    input.click();
  });
}

/** Only a committed, verified setup is done; every other engine outcome stays unfinished. */
const setupResult = (row: RecoveryWorkspaceResult | undefined) =>
  row?.outcome === 'recoverable'
    ? { outcome: 'Committed', recoverable: true }
    : { outcome: row?.outcome ?? 'Failed', recoverable: false };

/**
 * The encryption console's recovery port over the shared per-workspace engine, for
 * browser-shaped hosts. The adapter owns the unlock: the recovery file is read here
 * and wiped after the command, and only outcomes, names and IDs are returned. File
 * replacement is not offered (the engine has none); creation needs the host's `saveFile`.
 */
export function recoveryWorkspacesPort(host: RecoveryWorkspacesPortHost) {
  const unlocked = async <A>(
    method: Method,
    options: UnlockOptions | undefined,
    work: (engine: Engine, unlock: ClientRecoveryUnlock) => Promise<A>
  ): Promise<A | typeof cancelled> => {
    // Open the chooser before any await: WebKit requires the tap's activation.
    const chosen = method === 'file' ? host.chooseFile() : null;
    let file: Uint8Array | null = null;
    try {
      if (chosen) {
        file = await chosen;
        if (!file) return cancelled;
      }
      if (method === 'password' && !options?.password) {
        throw new Error('e2ee_recovery_invalid-input');
      }
      const engine = await host.engine();
      const unlock: ClientRecoveryUnlock = file
        ? { file }
        : method === 'password'
          ? { password: options!.password! }
          : 'passkey';
      return await work(engine, unlock);
    } catch (error) {
      if (error instanceof Error && error.message === 'e2ee_recovery_cancelled') return cancelled;
      throw error;
    } finally {
      // The engine copies the file when it opens the vault, before any progress.
      file?.fill(0);
    }
  };
  const read = async <A>(work: (engine: Engine) => Effect.Effect<A, unknown>) =>
    host.run(work(await host.engine()));
  /**
   * Returns as soon as every selected workspace has a result. A workspace whose wait the
   * engine reports as `Unconfirmed` (its bounded wait ran out) does not hold the others:
   * its producer keeps its vault, journal and submission and settles on its own, and the
   * next plan read shows the outcome. Only an engine failure before that rejects.
   */
  const batch = (
    start: (
      observe: (progress: RecoveryWorkspaceProgress) => void
    ) => Effect.Effect<RecoveryWorkspaceResult[], unknown>,
    view?: (rows: readonly RecoveryWorkspaceResult[]) => void
  ) =>
    new Promise<RecoveryWorkspaceResult[]>((resolve, reject) => {
      let answered = false;
      const answer = (rows: RecoveryWorkspaceResult[]) => {
        if (answered) return;
        answered = true;
        resolve(rows);
      };
      host
        .run(
          start((progress) => {
            view?.(progress.results);
            if (!progress.waiting) answer(progress.results);
          })
        )
        .then(answer, (error) => {
          if (answered) return;
          answered = true;
          reject(error);
        });
    });
  // One unlock for every selected workspace; each is reported on its own, including
  // workspaces the engine did not return (no longer visible), which count as failed.
  const setup = (workspaceIds: readonly string[], method: Method, options?: UnlockOptions) =>
    unlocked(method, options, async (engine, unlock) => {
      const rows = await batch((observe) => engine.setup(unlock, workspaceIds, observe));
      return workspaceIds.map((workspaceId) => ({
        workspaceId,
        ...setupResult(rows.find((row) => row.workspaceId === workspaceId)),
      }));
    });
  // Core deliberately hides host I/O errors behind storage. Retain the person's
  // cancellation outside that boundary without weakening core's upload rules.
  const saving = async <A>(
    work: (save: (file: Uint8Array) => Promise<Uint8Array>) => Promise<A>
  ) => {
    let dismissed = false;
    try {
      return await work(async (file) => {
        const read = await host.saveFile!(file);
        if (!read) {
          dismissed = true;
          throw new Error('e2ee_recovery_cancelled');
        }
        return read;
      });
    } catch (error) {
      if (dismissed || (error instanceof Error && error.message === 'e2ee_recovery_cancelled'))
        return cancelled;
      throw error;
    }
  };
  return {
    plan: () => read((engine) => engine.plan()),
    // The service gives no event IDs; a display key from the kept fields is enough.
    securityEvents: () =>
      read((engine) =>
        Effect.map(engine.events(), (events) =>
          events.map((event, index) => ({
            id: `${event.kind}:${event.occurredAt}:${index}`,
            kind: event.kind,
            occurredAt: event.occurredAt,
          }))
        )
      ),
    passkeyAvailable: () => read((engine) => engine.available()),
    create: host.saveFile
      ? () =>
          saving(async (save) => {
            const created = await read((engine) => engine.create(save));
            return { outcome: 'created' as const, vaultId: created.vaultId };
          })
      : null,
    createWithPasskey: host.saveFile
      ? async (label?: string) => {
          try {
            const name = label ?? (await host.defaultLabel());
            const created = await read((engine) => engine.createWithPasskey(name));
            return { outcome: 'created' as const, vaultId: created.vaultId };
          } catch (error) {
            if (error instanceof Error && error.message === 'e2ee_recovery_cancelled')
              return cancelled;
            throw error;
          }
        }
      : null,
    createWithPassword: host.saveFile
      ? async (password: string) => {
          const created = await read((engine) => engine.createWithPassword(password));
          return { outcome: 'created' as const, vaultId: created.vaultId };
        }
      : null,
    saveFile: host.saveFile
      ? (method: Method, options?: UnlockOptions) =>
          unlocked(method, options, (engine, unlock) =>
            saving(async (save) => {
              const saved = await host.run(engine.saveFile(unlock, save));
              return { outcome: 'saved' as const, vaultId: saved.vaultId };
            })
          )
      : null,
    setPassword: (input: { password: string; method: Method; currentPassword?: string }) =>
      unlocked(
        input.method,
        input.currentPassword === undefined ? undefined : { password: input.currentPassword },
        (engine, unlock) =>
          host.run(
            Effect.as(engine.setPassword(unlock, input.password), { outcome: 'updated' as const })
          )
      ),
    removePassword: (method: Method, options?: UnlockOptions) =>
      unlocked(method, options, (engine, unlock) =>
        host.run(
          Effect.map(engine.removePassword(unlock), (result) => ({
            outcome: result.removed ? ('removed' as const) : ('incomplete' as const),
            pending: result.pending,
          }))
        )
      ),
    /**
     * Restores every workspace the plan leaves uncovered. Each row carries its workspace
     * ID and any partial key recovery. `onResult` sees each settled row as it arrives,
     * until this call returns or `observationSignal` aborts; neither cancels a producer.
     */
    restore: (
      method: Method,
      options?: UnlockOptions,
      onResult?: (result: RecoveryWorkspaceResult) => void,
      observationSignal?: AbortSignal
    ) =>
      unlocked(method, options, async (engine, unlock) => {
        const plan = await host.run(engine.plan());
        const ids = plan.uncovered.map((workspace) => workspace.id);
        let observing = true;
        const seen = new Map<string, string>();
        const observe = (rows: readonly RecoveryWorkspaceResult[]) => {
          if (!observing || observationSignal?.aborted || !onResult) return;
          for (const row of rows) {
            const key = `${row.outcome}:${row.partialEpochKey === true}`;
            if (seen.get(row.workspaceId) === key) continue;
            seen.set(row.workspaceId, key);
            try {
              onResult(row);
            } catch {
              /* A view cannot cancel a producer or replace its result. */
            }
          }
        };
        try {
          const rows = ids.length
            ? await batch((progress) => engine.restore(unlock, ids, progress), observe)
            : [];
          return {
            outcome: 'restored' as const,
            results: rows,
          };
        } finally {
          observing = false;
        }
      }),
    setupWorkspace: async (
      workspaceId: string,
      method: Method = 'file',
      options?: UnlockOptions
    ) => {
      const settled = await setup([workspaceId], method, options);
      return 'outcome' in settled ? settled : settled[0]!;
    },
    setupWorkspaces: async (
      workspaceIds: readonly string[],
      method: Method,
      options?: UnlockOptions
    ) => {
      const settled = await setup(workspaceIds, method, options);
      return 'outcome' in settled ? settled : { outcome: 'settled' as const, results: settled };
    },
    passkeyDefaultLabel: () => host.defaultLabel(),
    addPasskey: (label: string, method: Method = 'file', options?: UnlockOptions) =>
      unlocked(method, options, (engine, unlock) =>
        host.run(Effect.as(engine.add(unlock, label), { outcome: 'added' as const }))
      ),
    listPasskeys: (method: Method = 'file', options?: UnlockOptions) =>
      unlocked(method, options, (engine, unlock) =>
        host.run(
          Effect.map(engine.passkeys(unlock), (state) => ({ outcome: 'listed' as const, ...state }))
        )
      ),
    removePasskey: (entryId: string, method: Method = 'file', options?: UnlockOptions) =>
      unlocked(method, options, (engine, unlock) =>
        // Without lists when the removal stood but the list could not be read again.
        host.run(
          Effect.map(engine.removePasskey(unlock, entryId), (result) =>
            'passkeys' in result
              ? {
                  outcome: result.removed ? ('removed' as const) : ('incomplete' as const),
                  passkeys: result.passkeys,
                  pending: result.pending,
                }
              : { outcome: 'removed' as const }
          )
        )
      ),
    checkFile: () =>
      unlocked('file', undefined, (engine, unlock) =>
        host.run(
          Effect.map(engine.inspect(unlock), (opened) => ({
            outcome: 'opened' as const,
            ...opened,
          }))
        )
      ),
    replacement: null,
  };
}
