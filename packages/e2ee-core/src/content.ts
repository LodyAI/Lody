import { Effect, Either } from 'effect';
import { runPromiseThrow } from './effect-run';
import { contentRuntimeLayer } from './platform/content';
import {
  inspectContentFrame,
  MAX_CONTENT_BYTES,
  type ContentAuthor,
  type ContentHeader,
  type ContentPolicy,
  type ContentPurpose,
  type ContentScope,
  type SealContent,
} from './pure/content-frame';
import { ContentError } from './pure/errors';
import { ControlLogError } from './pure/legacy-error';
import { authenticateContent, openContent, sealContent } from './workflows/content';

export type {
  ContentAuthor,
  ContentHeader,
  ContentPolicy,
  ContentPurpose,
  ContentScope,
  SealContent,
};
export { MAX_CONTENT_BYTES };

/** Unverified metadata for selecting a known epoch key; never an identity/permission assertion. */
export function inspectContent(frame: Uint8Array): Readonly<ContentHeader> {
  const parsed = inspectContentFrame(frame);
  if (Either.isLeft(parsed)) throw new ControlLogError(parsed.left.code);
  return parsed.right;
}

async function unwrap<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  try {
    return await runPromiseThrow(effect);
  } catch (error) {
    if (error instanceof ContentError) throw new ControlLogError(error.code);
    throw error;
  }
}

/** Stateless content protection only. No key storage, network, CRDT import or plaintext fallback.
 * Promise SDK boundary over workflows/content.ts. */
export class ContentCipher {
  private readonly layer: ReturnType<typeof contentRuntimeLayer>;
  constructor(
    policy: ContentPolicy,
    platform: Pick<Crypto, 'subtle' | 'getRandomValues'> = globalThis.crypto
  ) {
    this.layer = contentRuntimeLayer(policy, platform);
  }

  async seal(input: SealContent): Promise<Uint8Array<ArrayBuffer>> {
    return unwrap(sealContent(input).pipe(Effect.provide(this.layer)));
  }

  /** Verify the signature and return the header. Does not decrypt and is not publication admission. */
  async authenticate(frame: Uint8Array): Promise<Readonly<ContentHeader>> {
    return unwrap(authenticateContent(frame).pipe(Effect.provide(this.layer)));
  }

  async open(
    scope: ContentScope,
    epochKey: Uint8Array,
    frame: Uint8Array
  ): Promise<{ header: Readonly<ContentHeader>; plaintext: Uint8Array }> {
    return unwrap(openContent(scope, epochKey, frame).pipe(Effect.provide(this.layer)));
  }
}
