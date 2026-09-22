import { Effect, Layer } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import type { Entropy } from '@lody/e2ee-core';
import {
  Bytes,
  CryptoEntropy,
  CryptoError,
  StorageError,
  epochStreamDeliveryLayer,
  type GenesisHash,
} from '@lody/e2ee-core/effect';
import {
  deviceSignerLayer,
  hpkeRecipientLayer,
  hpkeSenderLayer,
  signatureVerifierLayer,
  streamsEpochLayer,
} from '@lody/e2ee-core/effect/platform';
import {
  nodeEpochFilesLayer,
  nodeKeyOutboxLayer,
  type EpochFileIO,
} from '@lody/e2ee-core/effect/platform-node';
import type { DemoDevice } from './device';
import type { LabFsShape } from '../services/fs';

/** Fault-injection adapter only. Normal Node composition keeps atomic/fsynced writes. */
export function testFiles(fs: LabFsShape): EpochFileIO {
  const perform = <A>(work: () => A) =>
    Effect.try({ try: work, catch: (error) => error }).pipe(
      Effect.catchAll((error) =>
        error instanceof TypeError || error instanceof ReferenceError
          ? Effect.die(error)
          : Effect.fail(new StorageError({ reason: 'io', code: 'lab-file-io' }))
      )
    );
  return {
    read: (path) =>
      Effect.gen(function* () {
        if (!(yield* perform(() => fs.exists(path))))
          return yield* Effect.fail(new StorageError({ reason: 'missing' }));
        return yield* perform(() => fs.readText(path));
      }),
    replace: (path, text) => perform(() => fs.writeText(path, text)),
    remove: (path) => perform(() => fs.unlink(path)),
  };
}

export function labEntropyLayer(entropy: Entropy): Layer.Layer<CryptoEntropy> {
  return Layer.succeed(CryptoEntropy, {
    bytes: (label, length) =>
      Effect.try({
        try: () => entropy.fill(label, new Uint8Array(length)),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof DOMException
            ? Effect.fail(new CryptoError({ operation: 'generate' }))
            : Effect.die(error)
        )
      ),
  });
}

function signerLayer(device: DemoDevice) {
  return Effect.map(Bytes.signingPublicKey(device.publicKey), (signer) =>
    deviceSignerLayer(signer, (bytes) => device.sign(bytes))
  );
}

export function sendKeyLayer(input: {
  readonly genesis: GenesisHash;
  readonly candidatePath: string;
  readonly keyringPath: string;
  readonly outboxPath: string;
  readonly outboxMode: 'create' | 'open';
  readonly device: DemoDevice;
  readonly entropy: Entropy;
  readonly streams: Pick<StreamsClient, 'read' | 'appendCas'>;
  readonly fs?: LabFsShape;
}) {
  return Effect.map(signerLayer(input.device), (signer) =>
    Layer.mergeAll(
      signer,
      nodeEpochFilesLayer({
        genesis: input.genesis,
        candidatePath: input.candidatePath,
        keyringPath: input.keyringPath,
        files: input.fs ? testFiles(input.fs) : undefined,
      }),
      nodeKeyOutboxLayer({ path: input.outboxPath, mode: input.outboxMode }),
      hpkeSenderLayer().pipe(Layer.provide(labEntropyLayer(input.entropy))),
      signatureVerifierLayer,
      epochStreamDeliveryLayer.pipe(Layer.provide(streamsEpochLayer(input.streams)))
    )
  );
}

export function receiveKeyLayer(input: {
  readonly genesis: GenesisHash;
  readonly candidatePath: string;
  readonly keyringPath: string;
  readonly device: DemoDevice;
  readonly fs?: LabFsShape;
}) {
  return Effect.map(signerLayer(input.device), (signer) =>
    Layer.mergeAll(
      signer,
      nodeEpochFilesLayer({
        genesis: input.genesis,
        candidatePath: input.candidatePath,
        keyringPath: input.keyringPath,
        files: input.fs ? testFiles(input.fs) : undefined,
      }),
      hpkeRecipientLayer(input.device.encryption),
      signatureVerifierLayer
    )
  );
}
