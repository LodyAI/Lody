import {
  checkHex,
  decodeRecord,
  invariant,
  signingBytes,
  type ControlEvent,
  type Signer,
  WebCryptoControl,
} from './wire';

/** Trusted input established by out-of-band verification/genesis onboarding, never by the server alone. */
export interface TrustAnchor<S> {
  readonly genesis: string;
  readonly state: S;
}

/** Part of the trusted computing base; must validate the complete action and reject unknown kinds. */
export interface ControlPolicy<S> {
  /** Pure/deterministic. Throws on denial; state is only published after all required signatures pass. */
  transition(
    state: S,
    event: ControlEvent
  ): {
    state: S;
    signers: readonly Signer[];
    /** Detached consent bound to this event by the policy; never a substitute for the actor signature. */
    proofs?: readonly SignatureProof[];
  };
}

export interface SignatureProof {
  readonly publicKey: string;
  readonly message: Uint8Array;
  readonly signature: string;
}

export interface ChainSnapshot<S> {
  readonly head: string;
  readonly length: number;
  readonly state: S;
}

/** Internal replay builder. Public callers use replayChain, never import a cached permission state. */
export class ChainVerifier<S> {
  private state: S;
  private head: string;
  private readonly operations = new Map<string, string>();
  private readonly genesis: string;

  constructor(
    anchor: TrustAnchor<S>,
    private readonly policy: ControlPolicy<S>,
    private readonly crypto: WebCryptoControl
  ) {
    checkHex(anchor.genesis, 32);
    this.genesis = anchor.genesis;
    this.head = anchor.genesis;
    this.state = structuredClone(anchor.state);
  }

  snapshot(): ChainSnapshot<S> {
    return { head: this.head, length: this.operations.size, state: structuredClone(this.state) };
  }

  operationWire(id: string): string | undefined {
    return this.operations.get(id);
  }

  async check(wire: string): Promise<{ state: S; hash: string; operationId: string }> {
    const { event, signatures } = decodeRecord(wire);
    invariant(event.genesis === this.genesis, 'wrong-genesis');
    invariant(event.previous === this.head, 'wrong-parent');
    invariant(!this.operations.has(event.operationId), 'operation-reused');
    const transition = this.policy.transition(structuredClone(this.state), event);
    const nextState = structuredClone(transition.state);
    const proofs = transition.proofs ?? [];
    invariant(proofs.length <= 8, 'too-many-consent-proofs');
    const stableProofs = proofs.map(({ publicKey, message, signature }) => {
      invariant(
        message instanceof Uint8Array && message.byteLength <= 4096,
        'invalid-consent-proof'
      );
      return { publicKey, message: new Uint8Array(message), signature };
    });
    const signers = transition.signers
      .map(({ id, publicKey }) => ({ id, publicKey }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    invariant(signers.length > 0 && signers.length === signatures.length, 'wrong-signers');
    invariant(
      signers.every((signer, i) => signer.id === signatures[i]![0]),
      'wrong-signers'
    );
    const bytes = signingBytes(
      event,
      signers.map(({ id }) => id)
    );
    for (let i = 0; i < signers.length; i++) {
      invariant(
        await this.crypto.verify(signers[i]!.publicKey, bytes, signatures[i]![1]),
        'bad-signature'
      );
    }
    for (const proof of stableProofs)
      invariant(
        await this.crypto.verify(proof.publicKey, proof.message, proof.signature),
        'bad-consent-signature'
      );
    return {
      state: nextState,
      hash: await this.crypto.hashRecord(wire),
      operationId: event.operationId,
    };
  }

  async append(wire: string): Promise<void> {
    const result = await this.check(wire);
    this.state = result.state;
    this.head = result.hash;
    this.operations.set(result.operationId, wire);
  }
}

export async function replayChain<S>(
  anchor: TrustAnchor<S>,
  records: readonly string[],
  policy: ControlPolicy<S>,
  crypto = new WebCryptoControl()
): Promise<ChainSnapshot<S>> {
  const verifier = new ChainVerifier(anchor, policy, crypto);
  for (const wire of [...records]) await verifier.append(wire);
  return verifier.snapshot();
}
