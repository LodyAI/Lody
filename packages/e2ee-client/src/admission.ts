import { Effect, Result } from 'effect';
import { z } from 'zod';
import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import type { LedgerView } from '@lody/e2ee-core';
import { Bytes, verifyLedgerEffect, contentPermissions } from '@lody/e2ee-core/protocol';
import type { ClientCustodyBinding } from '@lody/e2ee-core/services';
import { fromHex, toHex } from './bytes';
import { fail } from './errors';
import type { PersonalPairingOffer } from './pairing';

/** Capture bounded public pages before parsing or copying their contents. No page checksum/label grants authority. */
export function captureHistoryPages(source: unknown) {
  return Result.try({
    try: () => {
      if (!Array.isArray(source) || source.length < 1 || source.length > 256)
        throw fail('invalid-input');
      let bytes = 0;
      for (const value of source) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('recordsHex' in value) ||
          !Array.isArray(value.recordsHex) ||
          value.recordsHex.length > 64
        )
          throw fail('invalid-input');
        for (const record of value.recordsHex) {
          if (typeof record !== 'string' || record.length > 32768) throw fail('invalid-input');
          bytes += record.length / 2;
          if (bytes > 32 * 1024 * 1024) throw fail('invalid-input');
        }
      }
      return z
        .array(
          z
            .object({
              workspaceId: z.string().min(1).max(128),
              genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
              checkpoint: z
                .object({
                  length: z.number().int().positive().max(16384),
                  headHash: z.string().regex(/^[0-9a-f]{64}$/),
                })
                .strict(),
              startIndex: z.number().int().nonnegative(),
              recordsHex: z
                .array(
                  z
                    .string()
                    .regex(/^(?:[0-9a-f]{2})+$/)
                    .max(32768)
                )
                .max(64),
              position: z.string().min(1).max(1024),
              nextCursor: z.string().min(1).max(4096).nullable(),
            })
            .strict()
        )
        .min(1)
        .max(256)
        .parse(source);
    },
    catch: (cause) => fail('invalid-input', cause),
  });
}
/** Public signed history only. Receipts, account login and endpoint labels never supply authority. */
export const verifyPersonalHistory = Effect.fnUntraced(function* (
  offer: Pick<PersonalPairingOffer, 'workspaceId' | 'genesisHash' | 'genesisRecordHex'>,
  source: unknown
) {
  const pages = yield* Effect.fromResult(captureHistoryPages(source));
  const records: Uint8Array[] = [],
    endpoint = pages[0].checkpoint;
  let total = 0;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (
      page.workspaceId !== offer.workspaceId ||
      page.genesisHash !== offer.genesisHash ||
      page.startIndex !== records.length ||
      page.checkpoint.length !== endpoint.length ||
      page.checkpoint.headHash !== endpoint.headHash ||
      (index < pages.length - 1 && page.nextCursor === null)
    )
      return yield* fail('conflict');
    for (const record of page.recordsHex) {
      total += record.length / 2;
      if (total > 32 * 1024 * 1024) return yield* fail('invalid-input');
      records.push(fromHex(record));
    }
  }
  if (
    pages.at(-1)!.nextCursor !== null ||
    records.length !== endpoint.length ||
    toHex(records[0]) !== offer.genesisRecordHex
  )
    return yield* fail('conflict');
  return yield* verifyLedgerEffect({
    anchor: Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash))),
    records,
    checkpoint: {
      length: endpoint.length,
      head: Result.getOrThrow(Bytes.recordHash(fromHex(endpoint.headHash))),
    },
  });
});

/** Exact current personal membership and both actual public keys, checked before any key operation. */
export function assertPersonalAdmission(
  binding: ClientCustodyBinding,
  request: Pick<PersonalPairingOffer, 'workspaceId' | 'genesisHash' | 'membershipId'> & {
    signingPublicKey: string;
    encryptionPublicKey: string;
  },
  view: LedgerView
) {
  return Result.gen(function* () {
    if (
      binding.workspaceId !== request.workspaceId ||
      toHex(binding.genesis.toBytes()) !== request.genesisHash ||
      !view.genesis.equals(binding.genesis) ||
      toHex(binding.device.toBytes()) !== request.signingPublicKey
    )
      return yield* Result.fail(fail('scope-mismatch'));
    yield* contentPermissions(view, binding.device);
    const state = view.inspectState(),
      device = state.devices.get(request.signingPublicKey),
      member = device && state.members.get(toHex(device.membershipId.toBytes()));
    if (
      device?.kind !== 'personal' ||
      !member ||
      toHex(device.membershipId.toBytes()) !== request.membershipId ||
      toHex(device.encryptionPublicKey.toBytes()) !== request.encryptionPublicKey
    )
      return yield* Result.fail(fail('revoked'));
    return device;
  });
}
export type PersonalHistoryPages = readonly E2eeWorkspaceHistoryPage[];
