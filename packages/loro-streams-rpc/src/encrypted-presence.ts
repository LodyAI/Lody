import { Effect } from 'effect';
import { makePresenceContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import type { Bytes, DeviceSigner, LedgerView } from '@lody/e2ee-core/protocol';
import {
  parseEncryptedPresencePublication,
  ENCRYPTED_PRESENCE_MAX_BYTES,
  ENCRYPTED_PRESENCE_TTL_MS,
  type EncryptedPresenceEntry,
} from '@lody/shared/encrypted-presence';
import { encodeE2eePresenceBody, decodeE2eePresenceBody } from './e2ee-wire';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** Host-only presence semantics over purpose 7. No plaintext fallback or durable state.
 * One incarnation and sequence owner outlives transport restarts; replay floors
 * are bounded and retained through each authenticated body's entire validity.
 */
export const makeEncryptedPresence = Effect.fnUntraced(function* (input: {
  workspaceId: string;
  genesis: Bytes.GenesisHash;
  signer: DeviceSigner;
  ledger: () => Effect.Effect<LedgerView, unknown>;
  readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
  now: () => number;
  incarnation: Uint8Array;
}) {
  const binding = yield* makePresenceContentBinding({
    ...input,
    resource: `presence:${input.workspaceId}`,
  });
  const incarnation = Uint8Array.from(input.incarnation);
  let sequence = 0;
  const receivers = new WeakMap<
    object,
    Map<string, { incarnation: string; issuedAt: number; sequence: number; expiresAt: number }>
  >();
  const defaultReceiver = {};
  const checkIdentity = (
    view: LedgerView,
    author: string,
    state: ReturnType<typeof parseEncryptedPresencePublication>['state']
  ) => {
    const ledger = view.inspectState();
    const device = ledger.devices.get(author);
    const member = device && ledger.members.get(hex(device.membershipId.toBytes()));
    if (!device || !member || device.kind === 'recovery' || member.role === 'guest')
      throw new Error('e2ee_presence_invalid');
    if (
      state &&
      state.kind !== 'session-viewing' &&
      (device.kind !== 'machine' || state.machineId !== device.machineId)
    )
      throw new Error('e2ee_presence_invalid');
    if (
      state?.kind === 'session-viewing' &&
      (device.kind !== 'personal' || state.userId !== hex(member.userId.toBytes()))
    )
      throw new Error('e2ee_presence_invalid');
  };
  return {
    seal: (source: unknown, epoch: number) =>
      Effect.gen(function* () {
        const publication = yield* Effect.try(() => parseEncryptedPresencePublication(source));
        const issuedAt = publication.state?.updatedAt ?? input.now();
        const now = input.now();
        if (
          !Number.isSafeInteger(now) ||
          issuedAt > now ||
          now >= issuedAt + ENCRYPTED_PRESENCE_TTL_MS ||
          sequence > 0xffffffff
        )
          return yield* Effect.fail(new Error('e2ee_presence_invalid'));
        const view = yield* input.ledger();
        const author = hex(input.signer.publicKey.toBytes());
        const own = view.inspectState();
        const device = own.devices.get(author);
        const member = device && own.members.get(hex(device.membershipId.toBytes()));
        if (device?.kind === 'personal' && member && publication.key.startsWith('viewing:')) {
          const userId = hex(member.userId.toBytes());
          if (publication.state?.kind === 'session-viewing')
            publication.state = { ...publication.state, userId };
          publication.key = `viewing:${userId}:${publication.key.split(':').at(-1)}`;
        }
        yield* Effect.try(() => checkIdentity(view, author, publication.state));
        const payload = new TextEncoder().encode(JSON.stringify(publication));
        if (payload.byteLength > ENCRYPTED_PRESENCE_MAX_BYTES)
          return yield* Effect.fail(new Error('e2ee_presence_invalid'));
        return yield* Effect.acquireUseRelease(
          Effect.try(() =>
            encodeE2eePresenceBody({
              incarnation,
              sequence: sequence++,
              issuedAt,
              expiresAt: issuedAt + ENCRYPTED_PRESENCE_TTL_MS,
              payload,
            })
          ),
          (body) => binding.seal(body, epoch),
          (body) =>
            Effect.sync(() => {
              body.fill(0);
              payload.fill(0);
            })
        );
      }),
    open: (frame: Uint8Array, receiver: object = defaultReceiver) =>
      binding
        .open(frame, ({ plaintext: bytes, signer, view }) =>
          Effect.try((): EncryptedPresenceEntry | null => {
            const body = decodeE2eePresenceBody(bytes);
            try {
              const now = input.now();
              if (
                !Number.isSafeInteger(now) ||
                body.issuedAt > now ||
                now >= body.expiresAt ||
                body.payload.byteLength > ENCRYPTED_PRESENCE_MAX_BYTES
              )
                return null;
              const publication = parseEncryptedPresencePublication(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.payload))
              );
              const author = hex(signer.toBytes());
              checkIdentity(view, author, publication.state);
              if (publication.state && publication.state.updatedAt !== body.issuedAt) return null;
              let floors = receivers.get(receiver);
              if (!floors) {
                floors = new Map();
                receivers.set(receiver, floors);
              }
              for (const [key, floor] of floors) if (floor.expiresAt <= now) floors.delete(key);
              const key = `${author}:${publication.key}`;
              const floor = floors.get(key);
              const incomingIncarnation = hex(body.incarnation);
              if (
                floor &&
                (body.issuedAt < floor.issuedAt ||
                  (incomingIncarnation === floor.incarnation
                    ? body.sequence <= floor.sequence
                    : body.issuedAt <= floor.issuedAt))
              )
                return null;
              if (!floor && floors.size >= 4096) return null;
              floors.set(key, {
                incarnation: incomingIncarnation,
                issuedAt: body.issuedAt,
                sequence: body.sequence,
                expiresAt: Math.max(floor?.expiresAt ?? 0, body.expiresAt),
              });
              return { key, state: publication.state, expiresAt: body.expiresAt };
            } finally {
              body.payload.fill(0);
            }
          })
        )
        .pipe(Effect.catch(() => Effect.succeed(null))),
  };
});
