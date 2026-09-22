import { Effect, Layer } from 'effect';
import type { Entropy } from '@lody/e2ee-core';
import { Bytes, type GenesisHash } from '@lody/e2ee-core/effect';
import { deviceSignerLayer } from '@lody/e2ee-core/effect/platform';
import { nodeEpochFilesLayer } from '@lody/e2ee-core/effect/platform-node';
import type { DemoDevice } from './device';
import type { LabFsShape } from '../services/fs';
import { labEntropyLayer, testFiles } from './key-delivery-layer';

export function rotationLayer(input: {
  readonly genesis: GenesisHash;
  readonly candidatePath: string;
  readonly keyringPath: string;
  readonly device: DemoDevice;
  readonly entropy: Entropy;
  readonly fs?: LabFsShape;
}) {
  return Effect.map(Bytes.signingPublicKey(input.device.publicKey), (signer) =>
    Layer.mergeAll(
      deviceSignerLayer(signer, (bytes) => input.device.sign(bytes)),
      nodeEpochFilesLayer({ ...input, files: input.fs ? testFiles(input.fs) : undefined }),
      labEntropyLayer(input.entropy)
    )
  );
}
