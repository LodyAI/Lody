import { describe, expect, it } from 'vitest';
import type { OrgState } from '@lody/e2ee-core/ledger';
import { fromHex } from '../src/platform/bytes';
import {
  authorizeCurrentMember,
  authorizeJoinSigner,
  authorizeStreamRequest,
  isKnownStream,
} from '../src/platform/gateway';
import { CONTROL_STREAM, FLOCK_STREAM, KEYS_STREAM, LORO_STREAM } from '../src/platform/protocol';

const ownerHex = 'aa'.repeat(32);
const memberHex = 'bb'.repeat(32);
const guestHex = 'cc'.repeat(32);
const outsiderHex = 'dd'.repeat(32);
const ownerMem = '11'.repeat(16);
const memberMem = '22'.repeat(16);
const guestMem = '33'.repeat(16);
const genesisHex = 'ee'.repeat(32);
const otherGenesis = 'ff'.repeat(32);

function org(role: 'owner' | 'admin' | 'member' | 'guest' = 'member'): OrgState {
  return {
    genesis: fromHex(genesisHex),
    protocolVersion: 1,
    owner: fromHex(ownerMem.padEnd(64, '0')),
    members: new Map([
      [ownerMem, { userId: fromHex(ownerHex), role: 'owner' as const }],
      [memberMem, { userId: fromHex(memberHex), role }],
      [guestMem, { userId: fromHex(guestHex), role: 'guest' as const }],
    ]),
    devices: new Map([
      [
        ownerHex,
        {
          membershipId: fromHex(ownerMem),
          kind: 'personal' as const,
          encryptionPublicKey: fromHex('01'.repeat(32)),
          canManage: true,
        },
      ],
      [
        memberHex,
        {
          membershipId: fromHex(memberMem),
          kind: 'personal' as const,
          encryptionPublicKey: fromHex('02'.repeat(32)),
          canManage: false,
        },
      ],
      [
        guestHex,
        {
          membershipId: fromHex(guestMem),
          kind: 'personal' as const,
          encryptionPublicKey: fromHex('03'.repeat(32)),
          canManage: false,
        },
      ],
    ]),
    epoch: { number: 0, keyCommitment: fromHex('04'.repeat(32)), rotationRequired: false },
  };
}

describe('thin host gateway ACL', () => {
  it('does not treat Riverrun stream names as authorization', () => {
    expect(isKnownStream(LORO_STREAM)).toBe(true);
    expect(isKnownStream('secret-acl')).toBe(false);
  });

  it('rejects unbound tokens that are not on the current ledger', () => {
    expect(
      authorizeCurrentMember({
        state: org(),
        deviceHex: outsiderHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
      })
    ).toBe(false);
  });

  it('rejects a token bound to a different Org even if the device is a member', () => {
    expect(
      authorizeCurrentMember({
        state: org(),
        deviceHex: ownerHex,
        credentialGenesisHex: otherGenesis,
        requestGenesisHex: genesisHex,
      })
    ).toBe(false);
  });

  it('lets current members read every Org stream and forbids outsiders', () => {
    for (const stream of [CONTROL_STREAM, KEYS_STREAM, LORO_STREAM, FLOCK_STREAM]) {
      expect(
        authorizeStreamRequest({
          state: org('guest'),
          deviceHex: guestHex,
          credentialGenesisHex: null,
          requestGenesisHex: genesisHex,
          stream,
          method: 'GET',
          sub: undefined,
        })
      ).toEqual({ ok: true, action: 'read' });
      expect(
        authorizeStreamRequest({
          state: org(),
          deviceHex: outsiderHex,
          credentialGenesisHex: null,
          requestGenesisHex: genesisHex,
          stream,
          method: 'GET',
          sub: undefined,
        }).ok
      ).toBe(false);
    }
  });

  it('lets members write content and forbids guests', () => {
    expect(
      authorizeStreamRequest({
        state: org(),
        deviceHex: memberHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
        stream: LORO_STREAM,
        method: 'POST',
        sub: 'append-cas',
      })
    ).toEqual({ ok: true, action: 'content-cas' });
    expect(
      authorizeStreamRequest({
        state: org('guest'),
        deviceHex: guestHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
        stream: LORO_STREAM,
        method: 'POST',
        sub: 'append-cas',
      })
    ).toMatchObject({ ok: false, status: 403, error: 'unauthorized' });
  });

  it('uses canSendEpoch for the keys stream: any current device except recovery', () => {
    const recoveryHex = 'ab'.repeat(32);
    const base = org();
    const state: OrgState = {
      ...base,
      devices: new Map([
        ...base.devices,
        [
          recoveryHex,
          {
            membershipId: fromHex(memberMem),
            kind: 'recovery' as const,
            encryptionPublicKey: fromHex('04'.repeat(32)),
            canManage: false,
          },
        ],
      ]),
    };
    for (const deviceHex of [ownerHex, memberHex, guestHex]) {
      expect(
        authorizeStreamRequest({
          state,
          deviceHex,
          credentialGenesisHex: null,
          requestGenesisHex: genesisHex,
          stream: KEYS_STREAM,
          method: 'POST',
          sub: 'append-cas',
        })
      ).toEqual({ ok: true, action: 'keys-cas' });
    }
    expect(
      authorizeStreamRequest({
        state,
        deviceHex: recoveryHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
        stream: KEYS_STREAM,
        method: 'POST',
        sub: 'append-cas',
      })
    ).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('rejects DELETE and unknown streams without consulting storage', () => {
    expect(
      authorizeStreamRequest({
        state: org(),
        deviceHex: ownerHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
        stream: CONTROL_STREAM,
        method: 'DELETE',
        sub: undefined,
      })
    ).toMatchObject({ ok: false, error: 'method-not-allowed' });
    expect(
      authorizeStreamRequest({
        state: org(),
        deviceHex: ownerHex,
        credentialGenesisHex: null,
        requestGenesisHex: genesisHex,
        stream: 'other',
        method: 'GET',
        sub: undefined,
      })
    ).toMatchObject({ ok: false, status: 404, error: 'unknown-stream' });
  });

  it('binds join posts to the credential device', () => {
    expect(authorizeJoinSigner(memberHex, memberHex)).toBe(true);
    expect(authorizeJoinSigner(memberHex, outsiderHex)).toBe(false);
  });
});
