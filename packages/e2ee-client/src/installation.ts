import { Context, Effect, Layer, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  Bytes,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
} from '@lody/e2ee-core/protocol';
import {
  CLIENT_KEY_PURPOSES,
  ClientKeyCustody,
  ClientIdentityOriginals,
  ClientInstallationStore,
  ClientCustodyWriter,
  ClientPairingOriginalStore,
  type ClientCustodyBinding,
  type ClientInstallation,
  type ClientWrappedKey,
} from '@lody/e2ee-core/services';
import { PersonalHostPlatform } from './platform';
import {
  PersonalPairingOfferSchema,
  verifyPersonalOffer,
  verifyPersonalRequest,
  type PersonalPairingOffer,
} from './pairing';
import { credentialPacket, openCredentialPacket } from './identity';
import { fail } from './errors';
import { fromHex, toHex } from './bytes';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export const decode = (v: Uint8Array): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(v));
export const sameBinding = (a: ClientCustodyBinding, b: ClientCustodyBinding) =>
  a.accountId === b.accountId &&
  a.workspaceId === b.workspaceId &&
  a.genesis.equals(b.genesis) &&
  a.device.equals(b.device) &&
  a.installationId === b.installationId;
const rawBinding = (b: ClientCustodyBinding) => ({
  accountId: b.accountId,
  workspaceId: b.workspaceId,
  genesis: toHex(b.genesis.toBytes()),
  device: toHex(b.device.toBytes()),
  installationId: b.installationId,
});
export interface PreparedPersonalIdentity {
  readonly binding: ClientCustodyBinding;
  readonly offer: PersonalPairingOffer;
  readonly requestHex: string;
  readonly wrapped: readonly ClientWrappedKey[];
  readonly replacing: ClientCustodyBinding | null;
}
const requestKey = (b: ClientCustodyBinding, offer: PersonalPairingOffer) => ({
  ...b,
  pairingSessionId: offer.pairingSessionId,
  purpose: 'request' as const,
});
const own = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => fail('corrupt', cause) });
const services = Effect.gen(function* () {
  return Context.make(ClientInstallationStore, yield* ClientInstallationStore).pipe(
    Context.add(ClientCustodyWriter, yield* ClientCustodyWriter),
    Context.add(ClientPairingOriginalStore, yield* ClientPairingOriginalStore)
  );
});
export const acquirePersonalCustody = Effect.fnUntraced(function* (
  prepared: Pick<PreparedPersonalIdentity, 'binding' | 'offer' | 'replacing'>
) {
  const platform = yield* PersonalHostPlatform,
    base = yield* services;
  const ctx = yield* Layer.build(
    platform
      .custody(
        prepared.binding,
        prepared.replacing ? requestKey(prepared.binding, prepared.offer) : undefined
      )
      .pipe(Layer.provide(Layer.succeedContext(base)))
  );
  const custody = Context.get(ctx, ClientKeyCustody),
    originals = Context.get(ctx, ClientIdentityOriginals);
  if (
    !sameBinding(custody.binding, prepared.binding) ||
    !sameBinding(originals.binding, prepared.binding)
  )
    return yield* fail('scope-mismatch');
  return { custody, originals };
});
/** Read back all first wrappers and actual derived keys. No phase, receipt or availability label substitutes for this. */
export const openPreparedIdentity = Effect.fnUntraced(function* (
  prepared: PreparedPersonalIdentity,
  custody: ClientKeyCustody['Service']
) {
  const request = yield* Effect.fromResult(
    verifyPersonalRequest(prepared.offer, prepared.requestHex)
  );
  const bodies: Uint8Array[] = [];
  {
    for (const purpose of CLIENT_KEY_PURPOSES.slice(0, 3)) {
      const rows = prepared.wrapped.filter((row) => row.purpose === purpose);
      if (rows.length !== 1) return yield* fail('identity-lost');
      // Keep native completion and wipe registration in the same cancellation boundary.
      bodies.push(
        yield* Effect.acquireRelease(custody.unwrap(rows[0].purpose, rows[0].blob), (body) =>
          Effect.sync(() => body.fill(0))
        )
      );
    }
    const device = yield* importBrowserDevice({
      signingPrivate: bodies[0],
      encryptionPrivate: bodies[1],
    });
    const credential = yield* Effect.acquireRelease(
      Effect.sync(() => openCredentialPacket(prepared.binding, prepared.offer, bodies[2])).pipe(
        Effect.flatMap(Effect.fromResult)
      ),
      (value) => Effect.sync(() => value.fill(0))
    );
    if (
      !device.publicKey.equals(prepared.binding.device) ||
      toHex(device.publicKey.toBytes()) !== request.signingPublicKey ||
      toHex(device.enc.toBytes()) !== request.encryptionPublicKey ||
      toHex(sha256(credential)) !== request.credentialHash
    )
      return yield* fail('corrupt');
    for (const body of bodies) body.fill(0);
    return { device, credential, request };
  }
});
const saveWrappers = Effect.fnUntraced(function* (
  pairings: ClientPairingOriginalStore['Service'],
  anchor: ClientCustodyBinding,
  prepared: PreparedPersonalIdentity
) {
  const key = requestKey(anchor, prepared.offer),
    row = yield* pairings.load(key);
  if (!row) return yield* fail('corrupt');
  const receipt = encode(
    prepared.wrapped.map((w) => ({ purpose: w.purpose, blob: toHex(w.blob) }))
  );
  yield* pairings.compareAndSet(key, 1, { ...row, revision: 2, receipt });
  if (!sameBinding(anchor, prepared.binding)) {
    const candidateKey = requestKey(prepared.binding, prepared.offer),
      candidate = yield* pairings.load(candidateKey);
    if (!candidate || toHex(candidate.original) !== toHex(row.original))
      return yield* fail('conflict');
    yield* pairings.compareAndSet(candidateKey, 1, { ...candidate, revision: 2, receipt });
  }
  return undefined;
});
const advanceReady = Effect.fnUntraced(function* (
  store: ClientInstallationStore['Service'],
  current: ClientInstallation,
  prepared: PreparedPersonalIdentity
) {
  if (!sameBinding(current.binding, prepared.binding) || current.phase === 'retired')
    return yield* fail('identity-lost');
  if (
    current.phase !== 'prepared' &&
    (current.wrapped.length !== prepared.wrapped.length ||
      current.wrapped.some(
        (row) =>
          !prepared.wrapped.some(
            (original) =>
              original.purpose === row.purpose && toHex(original.blob) === toHex(row.blob)
          )
      ))
  )
    return yield* fail('corrupt');
  let row = current;
  if (row.phase === 'prepared') {
    row = { ...row, revision: row.revision + 1, phase: 'protected', wrapped: prepared.wrapped };
    yield* store.compareAndSet(row.revision - 1, row);
  }
  if (row.phase === 'protected')
    yield* store.compareAndSet(row.revision, {
      ...row,
      revision: row.revision + 1,
      phase: 'ready',
    });
  return undefined;
});

const signRequest = Effect.fnUntraced(function* (
  offer: PersonalPairingOffer,
  device: import('@lody/e2ee-core/adapters/browser-crypto').BrowserDevice,
  credential: Uint8Array,
  protection: 'web-crypto' | 'os-keystore'
) {
  const genesis = Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash)));
  const proof = yield* prepareDeviceAdmission({
    genesis,
    membershipId: Result.getOrThrow(Bytes.membershipId(fromHex(offer.membershipId))),
    encryptionPublicKey: device.enc,
    kind: 'personal',
    signer: device,
  });
  const credentialHash = sha256(credential);
  const bound = yield* signDeviceCredentialBinding({
    genesis,
    pairingSessionId: fromHex(offer.pairingSessionId),
    signingPublicKey: device.publicKey,
    credentialHash,
    signer: device,
  });
  return toHex(
    encode({
      ...offer,
      signingPublicKey: toHex(device.publicKey.toBytes()),
      encryptionPublicKey: toHex(device.enc.toBytes()),
      credentialHash: toHex(credentialHash),
      possessionSignature: toHex(proof.possessionSignature.toBytes()),
      bindingSignature: toHex(bound.toBytes()),
      protection,
    })
  );
});

/** Explicit installation only. Allocation through native settlement is one same-fiber writer operation; no network runs here. */
export const preparePersonalIdentity = Effect.fnUntraced(function* (
  source: PersonalPairingOffer,
  replacement = false,
  existingOnly = false
) {
  const platform = yield* PersonalHostPlatform,
    store = yield* ClientInstallationStore,
    writer = yield* ClientCustodyWriter,
    pairings = yield* ClientPairingOriginalStore;
  const offer = yield* own(() => PersonalPairingOfferSchema.parse(source));
  yield* Effect.fromResult(verifyPersonalOffer(offer));
  const scope = platform.scope;
  if (
    store.scope.accountId !== scope.accountId ||
    store.scope.workspaceId !== scope.workspaceId ||
    !store.scope.genesis.equals(scope.genesis) ||
    writer.scope.accountId !== scope.accountId ||
    writer.scope.workspaceId !== scope.workspaceId ||
    !writer.scope.genesis.equals(scope.genesis) ||
    offer.workspaceId !== scope.workspaceId ||
    offer.genesisHash !== toHex(scope.genesis.toBytes())
  )
    return yield* fail('scope-mismatch');
  return yield* writer.run(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = yield* store.read();
        if (existingOnly && (!current || current.phase !== 'ready'))
          return yield* fail('identity-lost');
        // The retained slot is the only discovery root, including replacement candidates.
        let retained: PreparedPersonalIdentity | undefined;
        if (current) {
          let cursor: string | null = null;
          for (let page = 0; page < 256; page++) {
            const listed: Effect.Success<
              ReturnType<ClientPairingOriginalStore['Service']['list']>
            > = yield* pairings.list(current.binding, cursor, 64);
            for (const row of listed.entries) {
              if (
                row.key.purpose !== 'request' ||
                row.key.pairingSessionId !== offer.pairingSessionId
              )
                continue;
              const saved = yield* own(
                () =>
                  decode(row.value.original) as {
                    version: number;
                    binding: ReturnType<typeof rawBinding>;
                    offer: PersonalPairingOffer;
                    requestHex: string;
                    replacing: ReturnType<typeof rawBinding> | null;
                  }
              );
              const binding = yield* own(() => ({
                ...saved.binding,
                genesis: Result.getOrThrow(Bytes.genesisHash(fromHex(saved.binding.genesis))),
                device: Result.getOrThrow(Bytes.signingPublicKey(fromHex(saved.binding.device))),
              }));
              const replacing = sameBinding(binding, current.binding) ? null : current.binding;
              if (
                saved.version !== 1 ||
                JSON.stringify(saved.offer) !== JSON.stringify(offer) ||
                binding.accountId !== scope.accountId ||
                binding.workspaceId !== scope.workspaceId ||
                !binding.genesis.equals(scope.genesis) ||
                !/^[0-9a-f]{64}$/.test(binding.installationId) ||
                (replacing !== null && !replacement) ||
                (replacement && replacing === null && saved.replacing === null)
              )
                return yield* fail('conflict');
              const wrapped = row.value.receipt
                ? yield* own(() =>
                    (
                      decode(row.value.receipt!) as {
                        purpose: ClientWrappedKey['purpose'];
                        blob: string;
                      }[]
                    ).map((w) => ({ purpose: w.purpose, blob: fromHex(w.blob) }))
                  )
                : [];
              retained = { binding, offer, requestHex: saved.requestHex, wrapped, replacing };
            }
            if (listed.next === null) break;
            if (page === 255 || listed.next === cursor) return yield* fail('corrupt');
            cursor = listed.next;
          }
          if (retained) {
            yield* Effect.fromResult(verifyPersonalRequest(offer, retained.requestHex));
            const { custody, originals } = yield* acquirePersonalCustody(retained);
            if (retained.wrapped.length === 0) {
              const wrapped = yield* originals.read();
              if (wrapped.length !== 3) return yield* fail('identity-lost');
              retained = { ...retained, wrapped };
              yield* saveWrappers(pairings, current.binding, retained);
            }
            yield* openPreparedIdentity(retained, custody);
            if (!retained.replacing) yield* advanceReady(store, current, retained);
            return retained;
          }
          if (existingOnly) return yield* fail('identity-lost');
          // Never fork a second candidate while an earlier request has an unknown result.
          let previous: PreparedPersonalIdentity | undefined;
          let guardCursor: string | null = null;
          for (let page = 0; page < 256; page++) {
            const all: Effect.Success<ReturnType<ClientPairingOriginalStore['Service']['list']>> =
              yield* pairings.list(current.binding, guardCursor, 64);
            for (const row of all.entries) {
              if (row.key.purpose !== 'request') continue;
              const saved = yield* own(
                () =>
                  decode(row.value.original) as {
                    version: number;
                    binding: ReturnType<typeof rawBinding>;
                    offer: PersonalPairingOffer;
                    requestHex: string;
                  }
              );
              const binding = yield* own(() => ({
                ...saved.binding,
                genesis: Result.getOrThrow(Bytes.genesisHash(fromHex(saved.binding.genesis))),
                device: Result.getOrThrow(Bytes.signingPublicKey(fromHex(saved.binding.device))),
              }));
              const claim = yield* pairings.load({
                ...binding,
                pairingSessionId: saved.offer.pairingSessionId,
                purpose: 'claim',
              });
              const terminal = claim?.receipt
                ? yield* own(
                    () =>
                      decode(claim.receipt!) as {
                        status: string;
                        accountId: string;
                        workspaceId: string;
                        genesisHash: string;
                        pairingSessionId: string;
                        requestHex: string;
                      }
                  )
                : null;
              const settled =
                terminal &&
                ['cancelled', 'conflict'].includes(terminal.status) &&
                terminal.accountId === binding.accountId &&
                terminal.workspaceId === binding.workspaceId &&
                terminal.genesisHash === toHex(binding.genesis.toBytes()) &&
                terminal.pairingSessionId === saved.offer.pairingSessionId &&
                terminal.requestHex === saved.requestHex;
              const approved = yield* pairings.load({
                ...binding,
                pairingSessionId: saved.offer.pairingSessionId,
                purpose: 'approval',
              });
              // A wrapped candidate is still unresolved. Only its exact typed terminal exchange permits another offer.
              if (!sameBinding(binding, current.binding) && !settled)
                return yield* fail('conflict');
              if (sameBinding(binding, current.binding)) {
                if (!settled && !approved) return yield* fail('conflict');
                if (
                  Object.keys(saved.offer).some(
                    (k) =>
                      k !== 'pairingSessionId' &&
                      saved.offer[k as keyof PersonalPairingOffer] !==
                        offer[k as keyof PersonalPairingOffer]
                  )
                )
                  return yield* fail('conflict');
                if (settled && row.value.receipt)
                  previous = {
                    binding,
                    offer: saved.offer,
                    requestHex: saved.requestHex,
                    replacing: null,
                    wrapped: yield* own(() =>
                      (
                        decode(row.value.receipt!) as {
                          purpose: ClientWrappedKey['purpose'];
                          blob: string;
                        }[]
                      ).map((w) => ({ purpose: w.purpose, blob: fromHex(w.blob) }))
                    ),
                  };
              }
            }
            if (all.next === null) break;
            if (page === 255 || all.next === guardCursor) return yield* fail('corrupt');
            guardCursor = all.next;
          }
          if (!replacement) {
            if (!previous || current.phase !== 'ready') return yield* fail('conflict');
            const { custody } = yield* acquirePersonalCustody(previous);
            const identity = yield* openPreparedIdentity(previous, custody);
            const requestHex = yield* signRequest(
              offer,
              identity.device,
              identity.credential,
              platform.protection
            );
            const nextSession = { ...previous, offer, requestHex };
            const original = encode({
              version: 1,
              binding: rawBinding(current.binding),
              offer,
              requestHex,
              replacing: null,
            });
            yield* pairings.compareAndSet(requestKey(current.binding, offer), null, {
              revision: 1,
              original,
              receipt: null,
            });
            yield* saveWrappers(pairings, current.binding, nextSession);
            return nextSession;
          }
          if (!platform.drainOld) return yield* fail('unsupported');
        } else if (replacement) return yield* fail('conflict');
        const signing = yield* Effect.acquireRelease(
          Effect.sync(() => crypto.getRandomValues(new Uint8Array(32))),
          (body) => Effect.sync(() => body.fill(0))
        );
        const encryption = yield* Effect.acquireRelease(
          Effect.sync(() => crypto.getRandomValues(new Uint8Array(32))),
          (body) => Effect.sync(() => body.fill(0))
        );
        const credential = yield* Effect.acquireRelease(
          Effect.sync(() => crypto.getRandomValues(new Uint8Array(32))),
          (body) => Effect.sync(() => body.fill(0))
        );
        {
          const device = yield* importBrowserDevice({
            signingPrivate: signing,
            encryptionPrivate: encryption,
          });
          const binding: ClientCustodyBinding = {
            ...scope,
            device: device.publicKey,
            installationId: toHex(crypto.getRandomValues(new Uint8Array(32))),
          };
          const requestHex = yield* signRequest(offer, device, credential, platform.protection);
          const prepared: PreparedPersonalIdentity = {
            binding,
            offer,
            requestHex,
            wrapped: [],
            replacing: current?.binding ?? null,
          };
          const original = encode({
            version: 1,
            binding: rawBinding(binding),
            offer,
            requestHex,
            replacing: current ? rawBinding(current.binding) : null,
          });
          if (!current)
            yield* store.compareAndSet(null, {
              binding,
              revision: 0,
              phase: 'prepared',
              wrapped: [],
            });
          yield* pairings.compareAndSet(requestKey(current?.binding ?? binding, offer), null, {
            revision: 1,
            original,
            receipt: null,
          });
          if (current)
            yield* pairings.compareAndSet(requestKey(binding, offer), null, {
              revision: 1,
              original,
              receipt: null,
            });
          const { custody } = yield* acquirePersonalCustody(prepared);
          yield* custody.create();
          const packet = yield* Effect.acquireRelease(
            Effect.sync(() => credentialPacket(binding, offer, credential)).pipe(
              Effect.flatMap(Effect.fromResult)
            ),
            (body) => Effect.sync(() => body.fill(0))
          );
          const wrapped: ClientWrappedKey[] = [];
          for (const [purpose, body] of [
            ['signing-private-key', signing],
            ['encryption-private-key', encryption],
            ['device-credential', packet],
          ] as const)
            wrapped.push({ purpose, blob: yield* custody.wrap(purpose, body) });
          const complete = { ...prepared, wrapped };
          yield* saveWrappers(pairings, current?.binding ?? binding, complete);
          yield* openPreparedIdentity(complete, custody);
          if (!current) yield* advanceReady(store, (yield* store.read())!, complete);
          signing.fill(0);
          encryption.fill(0);
          credential.fill(0);
          packet.fill(0);
          return complete;
        }
      })
    )
  );
});
