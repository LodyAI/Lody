import { Context, Effect } from 'effect';
import type { CryptoError } from '../pure/errors';

/** Fresh cryptographic randomness, produced only when the Effect executes. */
export class CryptoEntropy extends Context.Tag('@lody/e2ee-core/CryptoEntropy')<
  CryptoEntropy,
  {
    readonly bytes: (label: string, length: number) => Effect.Effect<Uint8Array, CryptoError>;
  }
>() {}
