/**
 * The browser `E2eePasskeyPort`, over `navigator.credentials`. It reports what the browser
 * returned and decides nothing: `@lody/e2ee-client/passkey-unlock` judges the result.
 * A browser without PRF returns `prfEnabled: false` and no result, never a substitute;
 * `available` is false where the browser does not itself report PRF support.
 */
import {
  E2eePasskeyCancelled,
  type E2eePasskeyAssertion,
  type E2eePasskeyPort,
  type E2eePasskeyRegistration,
} from '@lody/platform/e2ee-passkey';

type PrfResults = {
  readonly enabled?: boolean;
  readonly results?: { readonly first?: BufferSource };
};

const base64url = {
  encode(bytes: Uint8Array) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  decode(value: string) {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0)
    );
  },
};

const bytesOf = (value: BufferSource) =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value.slice(0))
    : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));

const challenge = () => crypto.getRandomValues(new Uint8Array(32));
const descriptors = (ids: readonly string[]) =>
  ids.map((id) => ({ type: 'public-key' as const, id: base64url.decode(id) }));

/** The system prompt was dismissed, or no credential applied. Both are the user's choice. */
async function ceremony<A>(work: () => Promise<A>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      throw new E2eePasskeyCancelled('e2ee_passkey_cancelled');
    throw error;
  }
}

type ClientCapabilities = () => Promise<Readonly<Record<string, boolean | undefined>>>;

/**
 * Only a real ceremony proves PRF; this says whether one can succeed in this browser.
 * WebAuthn alone is not enough: Safari 16.4–17.x and older Firefox create passkeys
 * without PRF. Only the browser's own `extension:prf` capability claims support, so a
 * browser without `getClientCapabilities` (or one that throws) is not offered passkeys.
 */
async function browserPrfAvailable(): Promise<boolean> {
  if (
    typeof PublicKeyCredential === 'undefined' ||
    typeof navigator.credentials?.get !== 'function'
  )
    return false;
  const capabilities = (PublicKeyCredential as unknown as { getClientCapabilities?: unknown })
    .getClientCapabilities;
  if (typeof capabilities !== 'function') return false;
  try {
    const reported = await (capabilities as ClientCapabilities).call(PublicKeyCredential);
    return reported?.['extension:prf'] === true;
  } catch {
    return false;
  }
}

export function browserPasskeyPort(): E2eePasskeyPort {
  return {
    available: browserPrfAvailable,
    register: async (request): Promise<E2eePasskeyRegistration> => {
      const created = await ceremony(() =>
        navigator.credentials.create({
          publicKey: {
            rp: { id: request.rpId, name: 'Lody recovery vault' },
            user: {
              id: new Uint8Array(request.userHandle),
              name: request.userName,
              displayName: request.userName,
            },
            challenge: challenge(),
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: {
              residentKey: 'required',
              requireResidentKey: true,
              userVerification: 'required',
            },
            excludeCredentials: descriptors(request.excludeCredentialIds),
            extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
          },
        })
      );
      if (!(created instanceof PublicKeyCredential)) throw new Error('e2ee_passkey_unavailable');
      const prf = (created.getClientExtensionResults() as { prf?: PrfResults }).prf;
      return {
        credentialId: base64url.encode(new Uint8Array(created.rawId)),
        prfEnabled: prf?.enabled === true,
      };
    },
    authenticate: async (request): Promise<E2eePasskeyAssertion> => {
      const assertion = await ceremony(() =>
        navigator.credentials.get({
          publicKey: {
            rpId: request.rpId,
            challenge: challenge(),
            userVerification: 'required',
            allowCredentials: descriptors(request.allowCredentialIds),
            extensions: {
              prf: { eval: { first: new Uint8Array(request.prfInput) } },
            } as AuthenticationExtensionsClientInputs,
          },
        })
      );
      if (!(assertion instanceof PublicKeyCredential)) throw new Error('e2ee_passkey_unavailable');
      const response = assertion.response as AuthenticatorAssertionResponse;
      const flags = new Uint8Array(response.authenticatorData)[32] ?? 0;
      const first = (assertion.getClientExtensionResults() as { prf?: PrfResults }).prf?.results
        ?.first;
      return {
        credentialId: base64url.encode(new Uint8Array(assertion.rawId)),
        userHandle: response.userHandle ? new Uint8Array(response.userHandle) : null,
        // WebAuthn authenticator data: rpIdHash (32 bytes), then flags; bit 2 is user verified.
        userVerified: (flags & 0x04) !== 0,
        prfFirst: first ? bytesOf(first) : null,
      };
    },
  };
}
