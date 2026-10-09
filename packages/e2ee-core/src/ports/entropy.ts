import { Context, Effect } from 'effect';
import type { CryptoError } from '../pure/errors';

/** Fresh cryptographic randomness, produced only when the Effect executes. */
export class CryptoEntropy extends Context.Service<
  CryptoEntropy,
  {
    readonly bytes: (label: string, length: number) => Effect.Effect<Uint8Array, CryptoError>;
  }
>()('@lody/e2ee-core/CryptoEntropy') {}
