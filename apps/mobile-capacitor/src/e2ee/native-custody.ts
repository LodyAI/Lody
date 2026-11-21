import { Context, Effect, Exit, Fiber, Layer, Option, Scope } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  ClientKeyCustody,
  ClientIdentityOriginals,
  ClientCustodyWriter,
  ClientInstallationStore,
  ClientPairingOriginalStore,
  ClientCustodyError,
  CLIENT_KEY_PURPOSES,
  type ClientCustodyBinding,
  type ClientKeyPurpose,
  type ClientPairingKey,
} from '@lody/e2ee-core/services';
import { nativeOriginals } from './native-originals';
export type NativeBinding = {
  accountId: string;
  workspaceId: string;
  genesisHash: string;
  deviceId: string;
  installationId: string;
};
export interface NativeKekBridge {
  status(input: NativeBinding): Promise<unknown>;
  install(input: NativeBinding): Promise<unknown>;
  wrap(input: NativeBinding & { purpose: string; plaintext: string }): Promise<unknown>;
  unwrap(input: NativeBinding & { purpose: string; wrapped: string }): Promise<unknown>;
  delete(input: NativeBinding): Promise<unknown>;
}
export interface NativeCustodyOptions {
  binding: ClientCustodyBinding;
  databaseName: string;
  plugin: NativeKekBridge;
  candidateRequest?: ClientPairingKey;
}
const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const nativeBinding = (b: ClientCustodyBinding): NativeBinding => ({
  accountId: b.accountId,
  workspaceId: b.workspaceId,
  genesisHash: hex(b.genesis.toBytes()),
  deviceId: hex(b.device.toBytes()),
  installationId: b.installationId,
});
const identity = (a: NativeBinding) =>
  JSON.stringify([a.accountId, a.workspaceId, a.genesisHash, a.deviceId, a.installationId]);
const nativeError = (cause: unknown) => {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  switch (code) {
    case 'LOCKED':
      return fail('locked');
    case 'REAPPROVAL_REQUIRED':
      return fail('identity-lost');
    case 'INSTALLATION_UNKNOWN':
      return fail('indeterminate');
    case 'AUTHENTICATION_FAILED':
    case 'INVALID_REQUEST':
      return fail('corrupt');
    default:
      return fail('unavailable');
  }
};
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: unknown, max: number) => {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) throw fail('corrupt');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw fail('corrupt');
  }
  if (bytes.length > max || encode(bytes) !== value) {
    bytes.fill(0);
    throw fail('corrupt');
  }
  return bytes;
};
const property = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null && key in raw
    ? (raw as Record<string, unknown>)[key]
    : undefined;
/** Captured native protection and first-ciphertext journal; approval stays in the public host. */
export const nativeCustody = (input: NativeCustodyOptions) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const binding = Object.freeze({ ...input.binding }),
        args = Object.freeze(nativeBinding(binding)),
        id = identity(args);
      const candidate = input.candidateRequest
        ? Object.freeze({ ...input.candidateRequest })
        : undefined;
      if (
        !input.databaseName ||
        [args.accountId, args.workspaceId].some(
          (x) => !x || x.includes('\0') || new TextEncoder().encode(x).length > 256
        ) ||
        ![args.genesisHash, args.deviceId, args.installationId].every((x) =>
          /^[0-9a-f]{64}$/.test(x)
        )
      )
        return yield* fail('corrupt');
      const plugin = input.plugin;
      if (
        !plugin ||
        ['status', 'install', 'wrap', 'unwrap', 'delete'].some(
          (method) => typeof plugin[method as keyof NativeKekBridge] !== 'function'
        )
      )
        return yield* fail('unavailable');
      const bridge = {
        status: plugin.status.bind(plugin),
        install: plugin.install.bind(plugin),
        wrap: plugin.wrap.bind(plugin),
        unwrap: plugin.unwrap.bind(plugin),
        delete: plugin.delete.bind(plugin),
      };
      const writer = yield* ClientCustodyWriter,
        store = yield* ClientInstallationStore,
        pairings = yield* Effect.serviceOption(ClientPairingOriginalStore);
      if (
        [writer.scope, store.scope].some(
          (scope) =>
            scope.accountId !== binding.accountId ||
            scope.workspaceId !== binding.workspaceId ||
            !scope.genesis.equals(binding.genesis)
        )
      )
        return yield* fail('corrupt');
      const journal = yield* nativeOriginals(input.databaseName, id);
      const operations = yield* Scope.make();
      let closed = false;
      yield* Effect.addFinalizer(() => {
        closed = true;
        return Scope.close(operations, Exit.void);
      });
      const owned = <A>(work: Effect.Effect<A, unknown>, abandon?: (value: A) => void) =>
        Effect.uninterruptible(
          writer.run(
            Effect.gen(function* () {
              if (closed) return yield* fail('closed');
              const raw = yield* Effect.forkIn(
                Effect.uninterruptible(
                  Effect.suspend(() => (closed ? Effect.fail(fail('closed')) : work))
                ),
                operations
              );
              const value = yield* Fiber.join(raw);
              if (closed) {
                abandon?.(value);
                return yield* fail('closed');
              }
              return value;
            })
          )
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof ClientCustodyError
              ? cause
              : fail(
                  property(cause, 'reason') === 'conflict'
                    ? 'conflict'
                    : property(cause, 'reason') === 'corrupt'
                      ? 'corrupt'
                      : 'unavailable'
                )
          )
        );
      const eligibility = Effect.gen(function* () {
        if (yield* store.readRetired(binding)) return yield* fail('identity-lost');
        const current = yield* store.read();
        if (current && identity(nativeBinding(current.binding)) === id) {
          if (current.phase === 'retired') return yield* fail('identity-lost');
          return current;
        }
        if (
          candidate &&
          current &&
          identity(nativeBinding(candidate)) === id &&
          candidate.purpose === 'request' &&
          Option.isSome(pairings) &&
          (yield* pairings.value.load(candidate))
        )
          return null;
        return yield* fail(current ? 'conflict' : 'indeterminate');
      });
      const native = <A>(call: () => Promise<A>) =>
        Effect.tryPromise({ try: call, catch: nativeError });
      const state = (raw: unknown): 'ready' | 'missing' => {
        if (property(raw, 'version') !== 1) throw fail('unavailable');
        if (property(raw, 'installationId') !== args.installationId) throw fail('corrupt');
        const value = property(raw, 'state');
        if (value !== 'ready' && value !== 'missing') throw fail('corrupt');
        return value;
      };
      const nativeState = () =>
        native(() => bridge.status(args)).pipe(
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => state(raw),
              catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('corrupt')),
            })
          )
        );
      const available = Effect.gen(function* () {
        yield* eligibility;
        const marker = yield* journal.marker();
        const status = yield* nativeState();
        if (status !== 'ready')
          return yield* fail(marker?.phase === 'available' ? 'identity-lost' : 'indeterminate');
        if (marker?.phase !== 'available')
          return yield* fail(
            marker?.phase === 'deleted' || marker?.phase === 'deleting'
              ? 'identity-lost'
              : 'indeterminate'
          );
        return marker;
      });
      const retained = new Map<string, Uint8Array>();
      const checkPurpose = (purpose: ClientKeyPurpose) => {
        if (!(CLIENT_KEY_PURPOSES as readonly string[]).includes(purpose)) throw fail('corrupt');
      };
      const custody = ClientKeyCustody.of({
        binding,
        status: () =>
          owned(
            Effect.gen(function* () {
              if (yield* store.readRetired(binding)) return yield* fail('identity-lost');
              const current = yield* store.read();
              if (current && identity(nativeBinding(current.binding)) !== id)
                return yield* fail('conflict');
              if (current?.phase === 'retired') return yield* fail('identity-lost');
              const marker = yield* journal.marker();
              const result = yield* Effect.result(nativeState());
              if (result._tag === 'Failure') {
                const reason = result.failure.reason;
                if (reason === 'locked') return 'locked' as const;
                if (reason === 'unavailable') return 'unavailable' as const;
                if (reason === 'indeterminate') return 'indeterminate' as const;
                return yield* result.failure;
              }
              if (marker?.phase === 'deleted' || marker?.phase === 'deleting')
                return yield* fail('identity-lost');
              if (marker?.phase === 'available' && result.success === 'ready')
                return 'available' as const;
              if (
                !marker &&
                result.success === 'missing' &&
                (!current || current.phase === 'prepared')
              )
                return (yield* journal.hasProtectionRecords())
                  ? ('indeterminate' as const)
                  : ('missing' as const);
              if (marker?.phase === 'available' && result.success === 'missing')
                return yield* fail('identity-lost');
              return 'indeterminate' as const;
            })
          ),
        create: () =>
          owned(
            Effect.gen(function* () {
              const current = yield* eligibility;
              let marker = yield* journal.marker();
              const status = yield* nativeState();
              if (marker?.phase === 'deleted' || marker?.phase === 'deleting')
                return yield* fail('identity-lost');
              if (marker?.phase === 'available') {
                if (status !== 'ready') return yield* fail('identity-lost');
                return undefined;
              }
              if (!marker && status === 'ready') return yield* fail('indeterminate');
              if (!(current?.phase === 'prepared' || candidate))
                return yield* fail('indeterminate');
              // The same transaction proves no protected original exists before
              // committing intent, including retries of this interrupted install.
              marker = yield* journal.prepareInstallation(marker);
              const result = yield* native(() => bridge.install(args));
              const installed = yield* Effect.try({
                try: () => state(result),
                catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('corrupt')),
              });
              if (installed !== 'ready' || (yield* nativeState()) !== 'ready')
                return yield* fail('indeterminate');
              yield* journal.setMarker(marker, 'available');
              return undefined;
            })
          ),
        wrap: (purpose, source) =>
          owned(
            Effect.acquireUseRelease(
              Effect.try({
                try: () => {
                  checkPurpose(purpose);
                  if (!(source instanceof Uint8Array) || source.length > 4096)
                    throw fail('corrupt');
                  return new Uint8Array(source);
                },
                catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('corrupt')),
              }),
              (body) =>
                Effect.gen(function* () {
                  yield* available;
                  const digest = hex(sha256(body)),
                    slot = purpose + '/' + digest;
                  const prior = yield* journal.wrap(purpose, digest);
                  if (prior && prior.digest !== digest) return yield* fail('conflict');
                  if (prior?.blob) return prior.blob;
                  if (prior && !retained.has(slot)) return yield* fail('indeterminate');
                  const pending = prior ?? (yield* journal.begin(purpose, digest));
                  let blob = retained.get(slot);
                  if (!blob) {
                    const response = yield* native(() =>
                      bridge.wrap({ ...args, purpose, plaintext: encode(body) })
                    );
                    blob = yield* Effect.try({
                      try: () => {
                        const value = decode(property(response, 'wrapped'), 4125);
                        if (value.length !== body.length + 29 || value[0] !== 1)
                          throw fail('corrupt');
                        return value;
                      },
                      catch: (cause) =>
                        cause instanceof ClientCustodyError ? cause : fail('corrupt'),
                    });
                    retained.set(slot, blob);
                  }
                  const result = yield* journal.complete(pending, blob);
                  retained.delete(slot);
                  return result;
                }),
              (body) => Effect.sync(() => body.fill(0))
            )
          ),
        unwrap: (purpose, inputBlob) =>
          owned(
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => {
                  checkPurpose(purpose);
                  if (
                    !(inputBlob instanceof Uint8Array) ||
                    inputBlob.length < 29 ||
                    inputBlob.length > 4125 ||
                    inputBlob[0] !== 1
                  )
                    throw fail('corrupt');
                },
                catch: () => fail('corrupt'),
              });
              const blob = new Uint8Array(inputBlob);
              yield* available;
              const result = yield* native(() =>
                bridge.unwrap({ ...args, purpose, wrapped: encode(blob) })
              );
              return yield* Effect.try({
                try: () => decode(property(result, 'plaintext'), 4096),
                catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('corrupt')),
              });
            }),
            (value) => value.fill(0)
          ),
        delete: () =>
          owned(
            Effect.gen(function* () {
              const current = yield* store.read(),
                retired = yield* store.readRetired(binding);
              if (!(current && identity(nativeBinding(current.binding)) === id) && !retired)
                return yield* fail('conflict');
              let marker = yield* journal.marker();
              if (!marker) return yield* fail('indeterminate');
              if (marker.phase !== 'deleted' && marker.phase !== 'deleting')
                marker = yield* journal.setMarker(marker, 'deleting');
              const result = yield* native(() => bridge.delete(args));
              if (property(result, 'state') !== 'deleted') return yield* fail('indeterminate');
              if (marker.phase !== 'deleted') yield* journal.setMarker(marker, 'deleted');
              return undefined;
            })
          ),
      });
      const originals = ClientIdentityOriginals.of({
        binding,
        read: () =>
          owned(
            Effect.gen(function* () {
              yield* eligibility;
              if ((yield* journal.marker())?.phase !== 'available')
                return yield* fail('indeterminate');
              const result = [];
              for (const purpose of [
                'signing-private-key',
                'encryption-private-key',
                'device-credential',
              ] as const) {
                const row = yield* journal.identity(purpose);
                if (row && !row.blob) return yield* fail('indeterminate');
                if (row?.blob)
                  result.push({
                    purpose,
                    blob: row.blob,
                  });
              }
              return result;
            })
          ),
      });
      return Context.make(ClientKeyCustody, custody).pipe(
        Context.add(ClientIdentityOriginals, originals)
      );
    })
  );
