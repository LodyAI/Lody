import {
  E2eePasskeyCancelled,
  type E2eePasskeyPort,
  type E2eePasskeyRegistrationRequest,
  type E2eePasskeyAssertionRequest,
  E2EE_PASSKEY_RP_ID,
} from '@lody/platform/e2ee-passkey';

/** Private Capacitor wire protocol for the public E2eePasskeyPort. */
export interface MobilePasskeyBridge {
  available(): Promise<{ available: boolean }>;
  register(input: {
    rpId: string;
    userHandle: string;
    userName: string;
    prfInput: string;
    excludeCredentialIds: readonly string[];
  }): Promise<{ credentialId: string; prfEnabled: boolean }>;
  authenticate(input: {
    rpId: string;
    prfInput: string;
    allowCredentialIds: readonly string[];
  }): Promise<{
    credentialId: string;
    userHandle: string | null;
    userVerified: boolean;
    prfFirst: string | null;
  }>;
}

const rpId = E2EE_PASSKEY_RP_ID;
const fail = () => new Error('e2ee_passkey_invalid_result');
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decode(value: string, maximum = 1024): Uint8Array {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > Math.ceil((maximum * 4) / 3)
  )
    throw fail();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
      char.charCodeAt(0)
    );
  } catch {
    throw fail();
  }
  if (bytes.length > maximum || encode(bytes) !== value) throw fail();
  return bytes;
}
function inputBytes(bytes: Uint8Array, maximum = 1024): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > maximum)
    throw new Error('e2ee_passkey_invalid_request');
  return encode(bytes);
}
function credentialIds(ids: readonly string[]): readonly string[] {
  if (ids.length > 64) throw new Error('e2ee_passkey_invalid_request');
  for (const id of ids) decode(id);
  return [...ids];
}

export function makeMobilePasskeyPort(input: {
  readonly enabled?: boolean;
  readonly bridge: MobilePasskeyBridge;
  /** Supply () => new E2eePasskeyCancelled('e2ee_passkey_cancelled') from the public port. */
  readonly cancelled?: () => Error;
}): E2eePasskeyPort {
  async function available(): Promise<boolean> {
    if (input.enabled !== true) return false;
    try {
      return (await input.bridge.available()).available === true;
    } catch {
      return false;
    }
  }
  async function ceremony<A>(requestedRp: string, work: () => Promise<A>): Promise<A> {
    if (requestedRp !== rpId) throw new Error('e2ee_passkey_invalid_request');
    if (!(await available())) throw new Error('e2ee_passkey_unavailable');
    try {
      return await work();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'cancelled'
      )
        throw input.cancelled?.() ?? new E2eePasskeyCancelled('e2ee_passkey_cancelled');
      throw new Error('e2ee_passkey_failed');
    }
  }
  return {
    available,
    async register(request: E2eePasskeyRegistrationRequest) {
      const excludeCredentialIds = credentialIds(request.excludeCredentialIds);
      if (
        request.userHandle.length !== 32 ||
        !request.userName ||
        new TextEncoder().encode(request.userName).length > 256
      )
        throw new Error('e2ee_passkey_invalid_request');
      const wire = {
        rpId: request.rpId,
        userName: request.userName,
        userHandle: inputBytes(request.userHandle, 32),
        prfInput: inputBytes(request.prfInput),
        excludeCredentialIds,
      };
      const created = await ceremony(request.rpId, () => input.bridge.register(wire));
      decode(created.credentialId);
      if (
        typeof created.prfEnabled !== 'boolean' ||
        excludeCredentialIds.includes(created.credentialId)
      )
        throw fail();
      return { credentialId: created.credentialId, prfEnabled: created.prfEnabled };
    },
    async authenticate(request: E2eePasskeyAssertionRequest) {
      const allowCredentialIds = credentialIds(request.allowCredentialIds);
      const wire = {
        rpId: request.rpId,
        prfInput: inputBytes(request.prfInput),
        allowCredentialIds,
      };
      const assertion = await ceremony(request.rpId, () => input.bridge.authenticate(wire));
      decode(assertion.credentialId);
      if (
        typeof assertion.userVerified !== 'boolean' ||
        (allowCredentialIds.length && !allowCredentialIds.includes(assertion.credentialId))
      )
        throw fail();
      const userHandle = assertion.userHandle === null ? null : decode(assertion.userHandle, 32);
      const prfFirst = assertion.prfFirst === null ? null : decode(assertion.prfFirst, 32);
      if (
        (userHandle !== null && userHandle.length !== 32) ||
        (prfFirst !== null && prfFirst.length !== 32)
      ) {
        prfFirst?.fill(0);
        throw fail();
      }
      return {
        credentialId: assertion.credentialId,
        userHandle,
        userVerified: assertion.userVerified,
        prfFirst,
      };
    },
  };
}
