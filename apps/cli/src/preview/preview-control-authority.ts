import { randomUUID } from 'node:crypto';
import {
  PreviewControlProofSchema,
  type PreviewControlIntent,
  type PreviewControlProof,
  type VerifyPreviewControlInput,
} from '@lody/shared';

type Verify = (
  input: VerifyPreviewControlInput
) => Promise<{ requesterUserId: string; expiresAt: number }>;

/** Remote-only admission. A new runtime nonce invalidates retained RPCs after restart. */
export class PreviewControlAuthority {
  readonly runtimeNonce = randomUUID();
  private readonly consumed = new Map<string, number>();

  constructor(
    private readonly verify: Verify | undefined,
    private readonly now: () => number
  ) {}

  async authorize(
    intent: Omit<PreviewControlIntent, 'runtimeNonce' | 'requestId'>,
    proof: PreviewControlProof,
    localProjectId?: string
  ): Promise<void> {
    const parsed = PreviewControlProofSchema.parse(proof);
    if (!this.verify) throw new Error('Remote preview authorization is unavailable.');
    if (parsed.runtimeNonce !== this.runtimeNonce)
      throw new Error('Preview runtime changed. Retry the operation.');
    for (const [id, expiresAt] of this.consumed)
      if (expiresAt <= this.now()) this.consumed.delete(id);
    if (this.consumed.has(parsed.requestId))
      throw new Error('Preview control request was already used.');
    const verified = await this.verify({
      intent: { ...intent, runtimeNonce: this.runtimeNonce, requestId: parsed.requestId },
      requestToken: parsed.requestToken,
      localProjectId,
    });
    if (verified.requesterUserId !== intent.requesterUserId || verified.expiresAt <= this.now()) {
      throw new Error('Preview control identity or expiry is invalid.');
    }
    // No async gap between the duplicate check and consume: concurrent duplicates execute once.
    if (this.consumed.has(parsed.requestId))
      throw new Error('Preview control request was already used.');
    this.consumed.set(parsed.requestId, verified.expiresAt);
  }
}
