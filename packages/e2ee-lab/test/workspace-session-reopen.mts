import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { DeviceSigner } from '@lody/e2ee-core';
import { importDevice } from '../src/platform/device';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
// Private synthetic harness input and pinned seed, not exported product custody.
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const ok = Result.getOrThrow;
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 51),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const endpoint = { head: ok(Bytes.recordHash(bytes(input.head))), length: input.length };
const output = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const signer: DeviceSigner = input.device
        ? yield* importDevice(input.device)
        : {
            publicKey: ok(
              Bytes.signingPublicKey(
                new Uint8Array(
                  createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
                )
              )
            ),
            sign: (message) =>
              Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, key))))),
          };
      const session = yield* openLabExistingWorkspace({
        baseUrl: input.baseUrl,
        path: input.path,
        journalPath: input.journalPath,
        mode: 'open',
        genesis: ok(Bytes.genesisHash(bytes(input.anchor))),
        expected: endpoint,
        checkpoint: () => Effect.succeed(endpoint),
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
        signer,
      });
      const current = yield* session.control.current();
      const result = yield* session.control.resume();
      return {
        length: current.view.length,
        head: Buffer.from(current.view.head.toBytes()).toString('hex'),
        offset: current.offset,
        pending: result !== null,
        ...(input.device
          ? { device: Buffer.from(signer.publicKey.toBytes()).toString('hex') }
          : {}),
      };
    })
  )
);
process.stdout.write(JSON.stringify(output));
