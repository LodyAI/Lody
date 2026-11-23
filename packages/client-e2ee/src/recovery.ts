import { Effect, Layer, Semaphore, type Scope } from 'effect';
import { api } from '@lody/cloud-api';
import { makeFunctionReference } from 'convex/server';
import type { PersonalCloudConnection } from '@lody/client-e2ee';
import { RecoveryVaults, type RecoveryVault } from '@lody/e2ee-core';
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services';
import { encodeRecoveryVaultCiphertext, decodeRecoveryVaultCiphertext } from '@lody/e2ee-core/host';
import {
  createVaultWithPasskey,
  enrollVaultPasskey,
  unlockVaultWithPasskey,
} from '@lody/e2ee-client/passkey-unlock';
import { E2eePasskeyCancelled, type E2eePasskeyPort } from '@lody/platform/e2ee-passkey';
import {
  removeVaultPasswordGuarded,
  setVaultPasswordVerified,
} from '@lody/e2ee-client/recovery-password';
import { recoveryServiceLocator } from '@lody/e2ee-client/recovery-locator';
import { clientRecoveryJournal } from './recovery-journal';
import { MAX_VAULT_PASSWORD_GENERATIONS, passwordWrapEntryId } from '@lody/e2ee-core/protocol';

// Additive capability: keep the private adapter buildable with the pinned older
// public core until its optional readEntries port is adopted. Replies stay untrusted.
const readEntriesQuery = makeFunctionReference<
  'query',
  { vaultId: string; entryIds: string[] },
  unknown[]
>('e2eeRecoveryVault:readEntries');

export type ClientRecoveryOptions = {
  readonly platform: 'mobile' | 'web';
  readonly accountId: string;
  readonly sessionId: string;
  readonly currentSession: () => { accountId: string; sessionId: string } | null;
  readonly enabled: () => boolean;
  readonly client: PersonalCloudConnection['client'];
  readonly passkey?: E2eePasskeyPort;
  /**
   * Product site URL or origin of the signed-in service; recovery files carry its canonical
   * origin (`recoveryServiceLocator`). Omitted, it is the page's own HTTP(S) origin, which is
   * the site origin for the hosted and self-hosted Web client. A host without an HTTP(S)
   * page origin, such as the Capacitor shell, must pass it; otherwise every command
   * refuses as `disabled`.
   */
  readonly serviceLocator?: string;
};
export type ClientRecoveryUnlock =
  | { readonly file: Uint8Array }
  | 'passkey'
  | { readonly password: string };
export type ClientSecurityEvent = {
  readonly kind:
    | 'personal_device_recovered'
    | 'vault_replacement_reserved'
    | 'vault_replacement_finished';
  readonly occurredAt: number;
};
export type ClientRecoverySummary = {
  readonly workspaces: number;
  readonly passkeys: readonly { entryId: string; label: string }[];
};

/** The service never chooses navigation; do not retain IDs or unknown payload fields. */
export function visibleSecurityEvents(events: readonly unknown[]): ClientSecurityEvent[] {
  const result: ClientSecurityEvent[] = [];
  for (const event of events) {
    if (
      typeof event !== 'object' ||
      event === null ||
      !('kind' in event) ||
      !('occurredAt' in event)
    )
      continue;
    const { kind, occurredAt } = event;
    if (
      kind !== 'personal_device_recovered' &&
      kind !== 'vault_replacement_reserved' &&
      kind !== 'vault_replacement_finished'
    )
      continue;
    if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0)
      continue;
    result.push({ kind, occurredAt });
  }
  return result.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 5);
}
const rpcTimeout = '90 seconds';
const errorCodes = new Set([
  'invalid-input',
  'authentication',
  'storage',
  'missing',
  'rollback',
  'prf-unavailable',
  'replacing',
  'cancelled',
  'disabled',
  'failed',
]);
function failure(error: unknown): Error {
  if (error instanceof E2eePasskeyCancelled) return new Error('e2ee_recovery_cancelled');
  if (
    error instanceof Error &&
    [...errorCodes].some((code) => error.message === `e2ee_recovery_${code}`)
  )
    return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    errorCodes.has(error.code)
  )
    return new Error(`e2ee_recovery_${error.code}`);
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'locator-mismatch'
  )
    return new Error('e2ee_recovery_authentication');
  return new Error('e2ee_recovery_failed');
}
/** The page's origin; non-HTTP(S) shells such as `capacitor://localhost` yield no locator. */
const pageOrigin = (): string | undefined =>
  typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : undefined;

/** One login owns commands until actual native/IDB/network settlement. Only non-secret summaries escape the Scope. */
export function makeClientRecovery(options: ClientRecoveryOptions) {
  const accountId = options.accountId,
    sessionId = options.sessionId,
    serviceLocator = recoveryServiceLocator(options.serviceLocator ?? pageOrigin());
  let retired = false;
  const commands = Semaphore.makeUnsafe(1);
  /** The signed-in service's canonical locator; without one recovery is unavailable. */
  const locator = () => {
    if (serviceLocator === null) throw new Error('e2ee_recovery_disabled');
    return serviceLocator;
  };
  const check = () => {
    if (!options.enabled()) throw new Error('e2ee_recovery_disabled');
    locator();
    const current = options.currentSession();
    if (
      retired ||
      !accountId ||
      !sessionId ||
      current?.accountId !== accountId ||
      current.sessionId !== sessionId
    )
      throw new Error('e2ee_recovery_cancelled');
  };
  const request = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        check();
        const result = await work();
        check();
        return result;
      },
      catch: (error) => error,
    });
  const rpc = <A>(work: () => Promise<A>) =>
    request(work).pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: rpcTimeout,
        orElse: () => Effect.fail(new Error('e2ee_recovery_failed')),
      }),
      Effect.interruptible
    );
  const port = (borrow: (prf: Uint8Array) => void = () => {}): E2eePasskeyPort => {
    if (!options.passkey) throw new Error('e2ee_recovery_prf-unavailable');
    const native = options.passkey;
    const guarded = async <A>(work: () => Promise<A>) => {
      check();
      const result = await work();
      if (
        typeof result === 'object' &&
        result !== null &&
        'prfFirst' in result &&
        result.prfFirst instanceof Uint8Array
      )
        borrow(result.prfFirst);
      try {
        check();
        return result;
      } catch (error) {
        if (
          typeof result === 'object' &&
          result !== null &&
          'prfFirst' in result &&
          result.prfFirst instanceof Uint8Array
        )
          result.prfFirst.fill(0);
        throw error;
      }
    };
    return {
      available: () => guarded(() => native.available()),
      register: (input) => guarded(() => native.register(input)),
      authenticate: (input) => guarded(() => native.authenticate(input)),
    };
  };
  const ciphertext = (value: unknown) =>
    value === null ? Effect.succeed(null) : Effect.fromResult(decodeRecoveryVaultCiphertext(value));
  const acknowledge = (reply: { ok: boolean }) =>
    reply.ok === true ? Effect.void : Effect.fail({ code: 'storage' });
  const store: RecoveryVaultStore['Service'] = {
    putImmutable: (vaultId, entry) =>
      rpc(() =>
        options.client.mutation(api.e2eeRecoveryVault.putImmutable, {
          vaultId,
          entry: encodeRecoveryVaultCiphertext(entry),
        })
      ).pipe(Effect.flatMap(acknowledge)),
    readEntry: (vaultId, entryId) =>
      rpc(() => options.client.query(api.e2eeRecoveryVault.readEntry, { vaultId, entryId })).pipe(
        Effect.flatMap(ciphertext)
      ),
    ...{
      readEntries: (vaultId: string, entryIds: readonly string[]) =>
        rpc(async () => {
          try {
            return await options.client.query(readEntriesQuery, {
              vaultId,
              entryIds: [...entryIds],
            });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes('Could not find public function') ||
              !error.message.includes('e2eeRecoveryVault:readEntries')
            )
              throw error;
            const rows: unknown[] = [];
            for (let i = 0; i < entryIds.length; i += 4)
              rows.push(
                ...(await Promise.all(
                  entryIds
                    .slice(i, i + 4)
                    .map((entryId) =>
                      options.client.query(api.e2eeRecoveryVault.readEntry, { vaultId, entryId })
                    )
                ))
              );
            return rows;
          }
        }).pipe(Effect.flatMap((rows) => Effect.forEach(rows, ciphertext))),
    },
    readIndex: (vaultId) =>
      rpc(() => options.client.query(api.e2eeRecoveryVault.readIndex, { vaultId })).pipe(
        Effect.flatMap(ciphertext)
      ),
    compareAndSwapIndex: (vaultId, expected, next, referencedEntryIds) =>
      rpc(() =>
        options.client.mutation(api.e2eeRecoveryVault.compareAndSwapIndex, {
          vaultId,
          expected,
          next: encodeRecoveryVaultCiphertext(next),
          referencedEntryIds: [...referencedEntryIds],
        })
      ).pipe(
        Effect.flatMap((reply) =>
          reply.outcome === 'Committed' || reply.outcome === 'Conflict'
            ? Effect.succeed(reply.outcome)
            : Effect.fail({ code: 'storage' })
        )
      ),
    deleteUnreferenced: (vaultId, entryId, expectedIndex) =>
      rpc(() =>
        options.client.mutation(api.e2eeRecoveryVault.deleteUnreferenced, {
          vaultId,
          entryId,
          expectedIndex,
        })
      ).pipe(Effect.flatMap(acknowledge)),
  };
  // Only public method metadata is cached, and only for an exact index revision.
  let knownMethods:
    | { vaultId: string; revision: number; hasPassword: boolean; hasPasskey: boolean }
    | undefined;
  const rememberMethods = (vault: RecoveryVault) =>
    Effect.gen(function* () {
      const index = yield* vault.readIndex();
      knownMethods = {
        vaultId: vault.vaultId,
        revision: index.header?.revision ?? -1,
        hasPassword: index.value.password !== undefined,
        hasPasskey: (index.value.passkeys?.length ?? 0) > 0,
      };
    });
  const layers = (journal: RecoveryVaultLocalStore['Service']) =>
    RecoveryVaults.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RecoveryVaultStore, store),
          Layer.succeed(RecoveryVaultLocalStore, journal)
        )
      )
    );
  const confirmFile =
    (saveAndRead: (file: Uint8Array) => Promise<Uint8Array>, capture: (file: Uint8Array) => void) =>
    (file: Uint8Array) =>
      Effect.acquireUseRelease(
        Effect.succeed(file),
        (bytes) =>
          request(async () => {
            const read = await saveAndRead(bytes);
            try {
              check();
              if (read.length !== bytes.length || !read.every((v, i) => v === bytes[i]))
                throw new Error('e2ee_recovery_authentication');
              capture(read.slice());
            } finally {
              read.fill(0);
            }
          }),
        (bytes) => Effect.sync(() => bytes.fill(0))
      );
  const run = <A, E>(work: Effect.Effect<A, E>) =>
    commands
      .withPermit(
        Effect.gen(function* () {
          yield* Effect.sync(check);
          return yield* work;
        })
      )
      .pipe(Effect.uninterruptible, Effect.mapError(failure));
  const summary = (vault: RecoveryVault): Effect.Effect<ClientRecoverySummary, unknown> =>
    Effect.gen(function* () {
      const index = yield* vault.readIndex();
      const passkeys = (index.value.passkeys ?? []).map(({ entryId, label }) => ({
        entryId,
        label,
      }));
      check();
      return { workspaces: index.value.entries.filter((entry) => !entry.retired).length, passkeys };
    });
  const use = <A>(
    unlock: ClientRecoveryUnlock,
    write: boolean,
    work: (
      vault: RecoveryVault,
      passkey: () => E2eePasskeyPort,
      local: RecoveryVaultLocalStore['Service']
    ) => Effect.Effect<A, unknown, RecoveryVaults | Scope.Scope>
  ) =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const borrowedPrfs = new Set<Uint8Array>();
          // Public validation may reject before taking ownership of an assertion's PRF.
          // The private operation retains final cleanup ownership on every exit path.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const bytes of borrowedPrfs) bytes.fill(0);
              borrowedPrfs.clear();
            })
          );
          const passkey = () => port((bytes) => borrowedPrfs.add(bytes));
          const journal = yield* clientRecoveryJournal(accountId, check, options.platform);
          return yield* Effect.gen(function* () {
            const vaults = yield* RecoveryVaults;
            const vault =
              unlock === 'passkey'
                ? yield* unlockVaultWithPasskey({
                    port: passkey(),
                    open: ({ vaultId, credential }) =>
                      vaults.openWithPasskey({ vaultId, locator: locator(), credential }),
                  })
                : 'password' in unlock
                  ? yield* Effect.gen(function* () {
                      const state = yield* rpc(() =>
                        options.client.query(api.e2eeRecoveryVault.replacementState, {})
                      );
                      if (!state.current) return yield* Effect.fail({ code: 'missing' });
                      return yield* vaults.openWithPassword({
                        vaultId: state.current,
                        locator: locator(),
                        password: unlock.password,
                      });
                    })
                  : yield* Effect.acquireUseRelease(
                      Effect.sync(() => {
                        if (unlock.file.length < 1 || unlock.file.length > 4096)
                          throw new Error('e2ee_recovery_invalid-input');
                        return unlock.file.slice();
                      }),
                      (file) => vaults.open({ recoveryFile: file, locator: locator() }),
                      (file) => Effect.sync(() => file.fill(0))
                    );
            if (write) {
              const state = yield* rpc(() =>
                options.client.query(api.e2eeRecoveryVault.replacementState, {})
              );
              if (vault.vaultId !== state.current)
                return yield* Effect.fail({ code: 'authentication' });
              if (state.replacing !== null && typeof state.replacing !== 'string')
                return yield* Effect.fail({ code: 'storage' });
              if (state.replacing) return yield* Effect.fail({ code: 'replacing' });
            }
            return yield* work(vault, passkey, journal);
          }).pipe(Effect.provide(layers(journal)));
        })
      )
    );
  const createWith = (
    work: (
      vaults: RecoveryVaults['Service'],
      passkey: () => E2eePasskeyPort
    ) => Effect.Effect<RecoveryVault, unknown, Scope.Scope>
  ) =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          if (
            (yield* rpc(() => options.client.query(api.e2eeRecoveryVault.hasAccountVault, {})))
              .exists
          )
            return yield* Effect.fail({ code: 'conflict' });
          const borrowed = new Set<Uint8Array>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const bytes of borrowed) bytes.fill(0);
            })
          );
          const journal = yield* clientRecoveryJournal(accountId, check, options.platform);
          return yield* Effect.gen(function* () {
            const vault = yield* work(yield* RecoveryVaults, () =>
              port((bytes) => borrowed.add(bytes))
            );
            yield* Effect.ignore(rememberMethods(vault));
            check();
            return { vaultId: vault.vaultId };
          }).pipe(Effect.provide(layers(journal)));
        })
      )
    );
  const read = <A, E>(work: Effect.Effect<A, E>) =>
    work.pipe(Effect.uninterruptible, Effect.mapError(failure));
  return {
    /** Internal composition only: never return vault handles or secrets to product UI. */
    withVault: use,
    /** Empty account vault: saving/re-importing the file precedes the first upload. */
    create: (saveAndRead: (file: Uint8Array) => Promise<Uint8Array>) =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            if (
              (yield* rpc(() => options.client.query(api.e2eeRecoveryVault.hasAccountVault, {})))
                .exists
            )
              return yield* Effect.fail({ code: 'conflict' });
            const journal = yield* clientRecoveryJournal(accountId, check, options.platform);
            return yield* Effect.gen(function* () {
              const vaults = yield* RecoveryVaults;
              let saved: Uint8Array | undefined;
              yield* Effect.addFinalizer(() => Effect.sync(() => saved?.fill(0)));
              const created = yield* vaults.create({
                locator: locator(),
                persistFile: confirmFile(saveAndRead, (file) => {
                  saved = file;
                }),
              });
              created.recoveryFile.fill(0);
              const reopened = yield* vaults.open({ recoveryFile: saved!, locator: locator() });
              yield* Effect.ignore(rememberMethods(reopened));
              const result = yield* summary(reopened);
              if (result.workspaces !== 0) return yield* Effect.fail({ code: 'authentication' });
              // The vault ID is public routing data, not a secret.
              return { ...result, vaultId: reopened.vaultId };
            }).pipe(Effect.provide(layers(journal)));
          })
        )
      ),
    createWithPasskey: (label: string) =>
      createWith((vaults, passkey) =>
        Effect.gen(function* () {
          const normalized = label.trim().replace(/\s+/gu, ' ');
          if (!normalized || normalized.length > 64)
            return yield* Effect.fail({ code: 'invalid-input' });
          const created = yield* createVaultWithPasskey({
            port: passkey(),
            label: normalized,
            create: (input) => vaults.createWithPasskey({ ...input, locator: locator() }),
          });
          return created.vault;
        })
      ),
    createWithPassword: (password: string) =>
      createWith((vaults) =>
        Effect.gen(function* () {
          const created = yield* vaults.createWithPassword({ locator: locator(), password });
          const reopened = yield* vaults.openWithPassword({
            vaultId: created.vault.vaultId,
            locator: locator(),
            password,
          });
          if (reopened.vaultId !== created.vault.vaultId)
            return yield* Effect.fail({ code: 'authentication' });
          return reopened;
        })
      ),
    saveFile: (
      unlock: ClientRecoveryUnlock,
      saveAndRead: (file: Uint8Array) => Promise<Uint8Array>
    ) =>
      use(unlock, true, (vault) =>
        Effect.gen(function* () {
          let saved: Uint8Array | undefined;
          yield* Effect.addFinalizer(() => Effect.sync(() => saved?.fill(0)));
          const created = yield* vault.createRecoveryFile({
            persistFile: confirmFile(saveAndRead, (file) => {
              saved = file;
            }),
          });
          created.recoveryFile.fill(0);
          const vaults = yield* RecoveryVaults;
          const reopened = yield* vaults.open({ recoveryFile: saved!, locator: locator() });
          if (reopened.vaultId !== vault.vaultId)
            return yield* Effect.fail({ code: 'authentication' });
          return { vaultId: vault.vaultId };
        })
      ),
    methods: (vaultId: string) =>
      read(
        Effect.gen(function* () {
          const hasFile = (yield* store.readEntry(vaultId, vaultId)) !== null;
          const index = yield* store.readIndex(vaultId);
          if (
            knownMethods?.vaultId === vaultId &&
            knownMethods.revision === (index?.revision ?? -1)
          )
            return {
              hasFile,
              hasPassword: knownMethods.hasPassword,
              hasPasskey: knownMethods.hasPasskey,
            };
          const slots = yield* Effect.all(
            Array.from({ length: MAX_VAULT_PASSWORD_GENERATIONS }, (_, generation) =>
              store.readEntry(vaultId, passwordWrapEntryId(vaultId, generation))
            )
          );
          return { hasFile, hasPassword: slots.some((entry) => entry !== null), hasPasskey: null };
        })
      ),
    available: () =>
      read(options.passkey ? request(() => port().available()) : Effect.succeed(false)),
    events: () =>
      read(
        rpc(() => options.client.query(api.accountSecurityEvents.list, { limit: 25 })).pipe(
          Effect.map((reply) => visibleSecurityEvents(reply.events))
        )
      ),
    list: (unlock: ClientRecoveryUnlock) => use(unlock, false, summary),
    add: (unlock: Uint8Array | ClientRecoveryUnlock, label: string) =>
      use(unlock instanceof Uint8Array ? { file: unlock } : unlock, true, (vault, passkey) =>
        Effect.gen(function* () {
          const normalized = label.trim().replace(/\s+/gu, ' ');
          if (!normalized || normalized.length > 64)
            return yield* Effect.fail({ code: 'invalid-input' });
          yield* enrollVaultPasskey({ vault, port: passkey(), label: normalized });
        })
      ),
    remove: (unlock: ClientRecoveryUnlock, entryId: string) =>
      use(unlock, true, (vault) => vault.removePasskey(entryId)),
    /** Set or rotate the current vault's password wrap, then prove it opens that vault. */
    setPassword: (unlock: ClientRecoveryUnlock, password: string) =>
      use(unlock, true, (vault) =>
        Effect.flatMap(setVaultPasswordVerified(vault, { password }), (reopened) =>
          Effect.ignore(rememberMethods(reopened))
        )
      ),
    /** Remove the password wrap once a file or passkey still unlocks the vault. */
    removePassword: (unlock: ClientRecoveryUnlock) =>
      use(unlock, true, (vault) =>
        removeVaultPasswordGuarded(vault).pipe(
          Effect.tap(() => Effect.ignore(rememberMethods(vault)))
        )
      ),
    dispose: () => {
      retired = true;
    },
  };
}
export type ClientRecovery = ReturnType<typeof makeClientRecovery>;

export { clientRecoveryJournal } from './recovery-journal';
