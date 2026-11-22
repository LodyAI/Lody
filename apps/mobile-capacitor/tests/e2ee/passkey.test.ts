import { describe, it, expect } from 'vitest';
import { E2eePasskeyCancelled } from '@lody/platform/e2ee-passkey';
import { makeMobilePasskeyPort, type MobilePasskeyBridge } from '../../src/e2ee/passkey';

const id = 'AQID';
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const bytes = new Uint8Array(32).fill(7);
const request = { rpId: 'lody.ai', prfInput: bytes, allowCredentialIds: [id] };
class Cancelled extends Error {}
const fixture = (changes: Partial<MobilePasskeyBridge> = {}, enabled = true) => {
  const bridge: MobilePasskeyBridge = {
    available: async () => ({ available: true }),
    register: async () => ({ credentialId: id, prfEnabled: true }),
    authenticate: async () => ({
      credentialId: id,
      userHandle: encode(bytes),
      userVerified: true,
      prfFirst: encode(bytes),
    }),
    ...changes,
  };
  return makeMobilePasskeyPort({ enabled, bridge, cancelled: () => new Cancelled() });
};
describe('iPhone recovery vault passkey boundary', () => {
  it('default-off builds and an unavailable native OS cannot start credential ceremonies', async () => {
    const forbidden = async () => {
      throw new Error('native work must not start');
    };
    const port = makeMobilePasskeyPort({
      bridge: {
        available: async () => ({ available: true }),
        register: forbidden,
        authenticate: forbidden,
      },
      cancelled: () => new Cancelled(),
    });
    expect(await port.available()).toBe(false);
    await expect(port.authenticate(request)).rejects.toThrow('e2ee_passkey_unavailable');
    const oldOS = fixture({
      available: async () => ({ available: false }),
      authenticate: forbidden,
    });
    await expect(oldOS.authenticate(request)).rejects.toThrow('e2ee_passkey_unavailable');
  });
  it('forwards the fixed RP, exact PRF salt and exclusion list; registration never supplies assertion PRF', async () => {
    const port = fixture({
      register: async (wire) => {
        expect(wire).toEqual({
          rpId: request.rpId,
          userHandle: encode(bytes),
          userName: 'Lody recovery vault',
          prfInput: encode(bytes),
          excludeCredentialIds: ['BAUG'],
        });
        return { credentialId: id, prfEnabled: false };
      },
    });
    expect(
      await port.register({
        ...request,
        userHandle: bytes,
        userName: 'Lody recovery vault',
        excludeCredentialIds: ['BAUG'],
      })
    ).toEqual({ credentialId: id, prfEnabled: false });
    await expect(
      fixture().register({
        ...request,
        userHandle: bytes,
        userName: 'Lody recovery vault',
        excludeCredentialIds: [id],
      })
    ).rejects.toThrow();
    await expect(port.authenticate({ ...request, rpId: 'evil.example' })).rejects.toThrow(
      'e2ee_passkey_invalid_request'
    );
  });
  it('returns fresh PRF bytes and permits discoverable assertions without claiming that a user handle proves a vault', async () => {
    const result = await fixture({
      authenticate: async (wire) => {
        expect(wire).toEqual({
          rpId: request.rpId,
          prfInput: encode(bytes),
          allowCredentialIds: [],
        });
        return { credentialId: id, userHandle: null, userVerified: false, prfFirst: encode(bytes) };
      },
    }).authenticate({ ...request, allowCredentialIds: [] });
    expect(result).toEqual({
      credentialId: id,
      userHandle: null,
      userVerified: false,
      prfFirst: bytes,
    });
    result.prfFirst?.fill(0);
    expect(bytes[0]).toBe(7);
  });
  it('does not promote malformed native evidence or another credential to an unlock result', async () => {
    for (const change of [
      { credentialId: 'AQID=' },
      { credentialId: 'BAUG' },
      { prfFirst: 'AQ' },
      { userHandle: 'AQ' },
      { userVerified: 'true' },
    ]) {
      const port = fixture({
        authenticate: async () =>
          ({
            credentialId: id,
            userHandle: encode(bytes),
            userVerified: true,
            prfFirst: encode(bytes),
            ...change,
          }) as never,
      });
      await expect(port.authenticate(request)).rejects.toThrow();
    }
    const absent = await fixture({
      authenticate: async () => ({
        credentialId: id,
        userHandle: null,
        userVerified: false,
        prfFirst: null,
      }),
    }).authenticate(request);
    expect(absent.prfFirst).toBeNull();
    expect(absent.userVerified).toBe(false);
  });
  it('maps only a system cancellation to the public cancellation error and hides native error details', async () => {
    await expect(
      fixture({
        authenticate: async () => {
          throw { code: 'cancelled', message: 'private native detail' };
        },
      }).authenticate(request)
    ).rejects.toBeInstanceOf(Cancelled);
    await expect(
      fixture({
        authenticate: async () => {
          throw new Error('private native detail');
        },
      }).authenticate(request)
    ).rejects.toThrow('e2ee_passkey_failed');
  });
});

it('the installed mobile port preserves the public cancellation error identity', async () => {
  const bridge: MobilePasskeyBridge = {
    available: async () => ({ available: true }),
    register: async () => {
      throw { code: 'cancelled' };
    },
    authenticate: async () => {
      throw { code: 'cancelled' };
    },
  };
  const port = makeMobilePasskeyPort({ enabled: true, bridge });
  await expect(port.authenticate(request)).rejects.toBeInstanceOf(E2eePasskeyCancelled);
});
