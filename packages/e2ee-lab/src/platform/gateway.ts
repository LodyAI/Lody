import { Data, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { historicalContentIdentity } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { contentPermissions, decodeRecord } from '@lody/e2ee-core/protocol';

export class LabGatewayError extends Data.TaggedError('LabGatewayError')<{
  readonly status: 403 | 404;
  readonly code: 'unauthorized' | 'unknown-stream' | 'method-not-allowed';
}> {}
const hex = (value: { toBytes(): Uint8Array }) => Buffer.from(value.toBytes()).toString('hex');
const deny = (code: LabGatewayError['code'], status: 403 | 404 = 403) =>
  Result.fail(new LabGatewayError({ status, code }));
/** Read/control route gate only, not bearer authentication or URL parsing. The actual host must
 * authenticate the credential and select its genuine current checkpoint independently
 * before calling. Public record verification and pinned CAS follow this gate;
 * signed-content admission belongs to the separate content gateway. */
export function authorizeLabStream(input: {
  readonly view: LedgerView;
  readonly authenticatedCredential: {
    readonly device: Bytes.SigningPublicKey;
    readonly genesis: Bytes.GenesisHash | null;
  };
  readonly requestGenesis: Bytes.GenesisHash;
  readonly stream: string;
  readonly method: string;
  readonly sub?: string;
  /** Candidate bytes only, not evidence of admission. Full public submission
   * verification, PoP, current permission and pinned CAS must still follow. */
  readonly controlRecord?: Uint8Array;
}) {
  return Result.try({
    try: () =>
      Result.gen(function* () {
        const { stream, method, sub, view, authenticatedCredential, requestGenesis } = input;
        if (!['control', 'loro', 'flock'].includes(stream))
          return yield* deny('unknown-stream', 404);
        const device = yield* Result.mapError(
          Bytes.signingPublicKey(authenticatedCredential.device.toBytes()),
          () => new LabGatewayError({ status: 403, code: 'unauthorized' })
        );
        // This genuine-view query checks the public core's private registration before any
        // caller-visible state/method is used. Forged structural LedgerViews are rejected.
        yield* Result.mapError(
          contentPermissions(view, device),
          () => new LabGatewayError({ status: 403, code: 'unauthorized' })
        );
        const request = yield* Result.mapError(
          Bytes.genesisHash(requestGenesis.toBytes()),
          () => new LabGatewayError({ status: 403, code: 'unauthorized' })
        );
        const borrowedBound = authenticatedCredential.genesis;
        const bound =
          borrowedBound === null
            ? null
            : yield* Result.mapError(
                Bytes.genesisHash(borrowedBound.toBytes()),
                () => new LabGatewayError({ status: 403, code: 'unauthorized' })
              );
        if (!view.genesis.equals(request) || (bound !== null && !bound.equals(request)))
          return yield* deny('unauthorized');
        const state = view.inspectState();
        const active = state.devices.get(hex(device));
        if (!active || !state.members.has(hex(active.membershipId))) {
          // A bound, genuinely historical device may learn its own revocation by
          // reading public signed control bytes. This grants no mailbox, content,
          // key, snapshot upload or write capability.
          if (
            bound !== null &&
            stream === 'control' &&
            (method === 'GET' || method === 'HEAD') &&
            sub === undefined
          ) {
            yield* Result.mapError(
              historicalContentIdentity(view, device),
              () => new LabGatewayError({ status: 403, code: 'unauthorized' })
            );
            return undefined;
          }
          return yield* deny('unauthorized');
        }
        if (
          (method === 'GET' || method === 'HEAD') &&
          (sub === undefined || sub === 'snapshot' || sub === 'bootstrap')
        )
          return undefined;
        // The settled exception is R authorizing its own new personal device.
        // Core derives ownership from the actor's member instance and verifies
        // the new device's bound PoP; this route screening is never admission.
        if (active.kind === 'recovery') {
          if (
            method !== 'POST' ||
            stream !== 'control' ||
            sub !== 'append-cas' ||
            !(input.controlRecord instanceof Uint8Array)
          )
            return yield* deny('unauthorized');
          const decoded = yield* Result.mapError(
            decodeRecord(input.controlRecord),
            () => new LabGatewayError({ status: 403, code: 'unauthorized' })
          );
          if (
            decoded.body.type !== 'ordinary' ||
            !decoded.body.signer.equals(device) ||
            decoded.body.operation.type !== 'admitDevice' ||
            decoded.body.operation.kind !== 'personal'
          )
            return yield* deny('unauthorized');
          return undefined;
        }
        if (method === 'POST' && sub === 'append-cas' && stream === 'control') return undefined;
        return yield* deny('method-not-allowed');
      }),
    catch: () => new LabGatewayError({ status: 403, code: 'unauthorized' }),
  }).pipe(Result.flatMap((value) => value));
}
