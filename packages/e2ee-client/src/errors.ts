import { Cause, Data } from 'effect';
/** Scoped personal-client failure. The opaque cause is for trusted local diagnostics only; product surfaces use code. */
export class PersonalHostError extends Data.TaggedError('PersonalHostError')<{
  readonly code:
    | 'closed'
    | 'invalid-input'
    | 'scope-mismatch'
    | 'conflict'
    | 'history-conflict'
    | 'approval-required'
    | 'identity-lost'
    | 'corrupt'
    | 'protection-unavailable'
    | 'keys-unavailable'
    | 'revoked'
    | 'unsupported'
    | 'storage'
    | 'network'
    | 'restart-required'
    | 'unauthorized'
    /** Automatic admission refused; see `AutomaticAdmissionRefusal`. Explicit approval remains. */
    | 'invitation-invalid'
    | 'invitation-endorser-ineligible'
    | 'invitation-expired'
    | 'invitation-mismatch'
    | 'invitation-used';
  readonly cause?: unknown;
}> {}
export const fail = (code: PersonalHostError['code'], cause?: unknown) =>
  new PersonalHostError({ code, ...(cause === undefined ? {} : { cause }) });

/** Complete multi-reason runtime failure. Recovery owners remain in the Cause; product diagnostics must not serialize it. */
export class PersonalRuntimeFailure extends Data.TaggedError('PersonalRuntimeFailure')<{
  readonly code: 'runtime-failed';
  readonly cause: Cause.Cause<unknown>;
}> {}

/** Exact access loss of this device. Raised only from the session's own verified ledger
 * classification, or constructed by a trusted credential-bound adapter that parsed the
 * server's typed refusal for this device's credential. Never built from an error message:
 * JWT, transport and parse failures stay ordinary failures and never authorize cleanup.
 * The runtime boundary projects it to `new Error(code)`, the product's exact result. */
export class PersonalAccessLoss extends Data.TaggedError('PersonalAccessLoss')<{
  readonly code: 'e2ee_device_revoked' | 'e2ee_member_removed';
}> {}

/** The verified classification of `selfKey` as an exact access loss, or null. `unknown`
 * (absent from a snapshot-only view) and `active` are never a loss. */
export const verifiedAccessLoss = (
  view: { readonly classifyDevice?: (key: string) => string },
  selfKey: string
): PersonalAccessLoss | null => {
  const classified = view.classifyDevice?.(selfKey);
  return classified === 'revoked'
    ? new PersonalAccessLoss({ code: 'e2ee_device_revoked' })
    : classified === 'member-removed'
      ? new PersonalAccessLoss({ code: 'e2ee_member_removed' })
      : null;
};

/** The access loss carried by a failure: only an actual `PersonalAccessLoss` instance in
 * its Cause or bounded `cause` chain, never a matching code or message string. Device
 * revocation wins over membership removal only by order of appearance; both are exact. */
export const findAccessLoss = (failure: unknown): PersonalAccessLoss['code'] | null => {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): PersonalAccessLoss['code'] | null => {
    if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (value instanceof PersonalAccessLoss) return value.code;
    if (Cause.isCause(value)) {
      for (const reason of value.reasons) {
        const found = Cause.isFailReason(reason)
          ? visit(reason.error, depth + 1)
          : Cause.isDieReason(reason)
            ? visit(reason.defect, depth + 1)
            : null;
        if (found) return found;
      }
      return null;
    }
    return 'cause' in value ? visit((value as { cause: unknown }).cause, depth + 1) : null;
  };
  return visit(failure, 0);
};

/** The product-facing exact access-loss result recognized by `e2eeAccessLoss`. */
export const accessLossError = (code: PersonalAccessLoss['code']) =>
  Object.assign(new Error(code), { code });
