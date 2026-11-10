/** Runs in a real browser page on the RP origin. Everything crossing back is plain data. */
import { Effect } from 'effect';
import { verifiedPasskeyPrf, verifiedPasskeyRegistration } from '@lody/e2ee-core/protocol';
import { browserPasskeyPort } from '../../src/passkey-browser';

const port = browserPasskeyPort();
const hex = (bytes: Uint8Array | null) =>
  bytes ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') : null;

export async function run(input: { prfInput: number[]; exclude?: string[] }) {
  const prfInput = new Uint8Array(input.prfInput);
  const created = await port.register({
    rpId: 'lody.ai',
    userHandle: new Uint8Array(32).fill(7),
    userName: 'Lody recovery vault',
    prfInput,
    excludeCredentialIds: input.exclude ?? [],
  });
  const known = await port.authenticate({
    rpId: 'lody.ai',
    prfInput,
    allowCredentialIds: [created.credentialId],
  });
  const discovered = await port.authenticate({
    rpId: 'lody.ai',
    prfInput,
    allowCredentialIds: [],
  });
  // The client contract judges what the browser reported, exactly as on other platforms.
  const registration = await Effect.runPromise(
    Effect.result(
      verifiedPasskeyRegistration({
        credentialId: created.credentialId,
        extension: { enabled: created.prfEnabled },
      })
    )
  );
  const first = known.prfFirst ? known.prfFirst.slice().buffer : new ArrayBuffer(0);
  const assertion = await Effect.runPromise(
    Effect.result(
      verifiedPasskeyPrf({
        credentialId: known.credentialId,
        userVerified: known.userVerified,
        extension: { results: { first } },
      })
    )
  );
  return {
    credentialId: created.credentialId,
    prfEnabled: created.prfEnabled,
    knownId: known.credentialId,
    knownPrf: hex(known.prfFirst),
    discoveredPrf: hex(discovered.prfFirst),
    discoveredHandle: hex(discovered.userHandle),
    userVerified: known.userVerified,
    registrationAccepted: registration._tag === 'Success',
    assertionAccepted: assertion._tag === 'Success',
  };
}

export async function available() {
  return port.available();
}

export async function dismissed() {
  try {
    await port.authenticate({
      rpId: 'lody.ai',
      prfInput: new Uint8Array([1]),
      allowCredentialIds: [],
    });
    return 'completed';
  } catch (error) {
    return error instanceof Error ? error.constructor.name + ':' + error.message : String(error);
  }
}
