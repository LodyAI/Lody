import { describe, expect, it } from 'vitest';
import {
  refContextMatches,
  refCursorAllowed,
  refMayAdmit,
  refMayRecover,
  refMaySendEpoch,
  refMayWriteDocument,
  refRetryPreservesCommit,
  refRevokeIsLocal,
  refSnapshotAdmissible,
  type RefDevice,
  type RefState,
} from '../src/reference-model';

function device(input: Partial<RefDevice> & Pick<RefDevice, 'id'>): RefDevice {
  return {
    user: 'alice',
    kind: 'personal',
    role: 'owner',
    canManage: true,
    ...input,
  };
}

function state(devices: RefDevice[], extra?: Partial<RefState>): RefState {
  return {
    org: 'org-a',
    epoch: 1,
    ownerUser: 'alice',
    devices: new Map(devices.map((row) => [row.id, row])),
    revoked: new Set(),
    ...extra,
  };
}

describe('independent reference model', () => {
  it('isolates org, resource, and epoch', () => {
    expect(
      refContextMatches({
        org: 'org-a',
        resource: 'loro',
        epoch: 1,
        boundOrg: 'org-b',
        boundResource: 'loro',
        boundEpoch: 1,
      })
    ).toBe(false);
    expect(
      refContextMatches({
        org: 'org-a',
        resource: 'loro',
        epoch: 0,
        boundOrg: 'org-a',
        boundResource: 'loro',
        boundEpoch: 1,
      })
    ).toBe(false);
  });

  it('rejects unauthorized admit, write, and epoch send', () => {
    const world = state([
      device({ id: 'owner' }),
      device({ id: 'guest', role: 'guest', canManage: false, user: 'bob' }),
      device({ id: 'machine', kind: 'machine', role: 'member', canManage: false, user: 'alice' }),
    ]);
    expect(refMayAdmit(world, 'guest', 'org-a')).toBe(false);
    expect(refMayWriteDocument(world, 'guest', 'org-a', 1)).toBe(false);
    expect(refMayWriteDocument(world, 'owner', 'org-b', 1)).toBe(false);
    expect(refMayWriteDocument(world, 'owner', 'org-a', 0)).toBe(false);
    expect(refMaySendEpoch(world, 'machine', 'org-a')).toBe(false);
    expect(refMaySendEpoch(world, 'owner', 'org-a')).toBe(true);
  });

  it('keeps recovery and revoke inside current membership', () => {
    const recovery = device({ id: 'r', kind: 'recovery', role: 'member', canManage: false });
    const world = state([device({ id: 'owner' }), recovery], { revoked: new Set(['r']) });
    expect(refMayRecover(world, 'r', 'alice', 'org-a')).toBe(false);
    expect(refMayRecover(state([device({ id: 'owner' }), recovery]), 'r', 'alice', 'org-a')).toBe(
      true
    );
    expect(refMayRecover(state([device({ id: 'owner' }), recovery]), 'r', 'bob', 'org-a')).toBe(
      false
    );
    expect(
      refRevokeIsLocal({ org: 'org-a', boundOrg: 'org-a', deviceId: 'd1', otherDeviceId: 'd2' })
        .otherUntouched
    ).toBe(true);
  });

  it('requires snapshot trust to match import context', () => {
    const world = state([device({ id: 'admin', role: 'admin' })]);
    expect(
      refSnapshotAdmissible({
        snapshotOrg: 'org-a',
        snapshotResource: 'loro',
        localOrg: 'org-a',
        localResource: 'loro',
        endorserId: 'admin',
        state: world,
      })
    ).toBe(true);
    expect(
      refSnapshotAdmissible({
        snapshotOrg: 'org-b',
        snapshotResource: 'loro',
        localOrg: 'org-a',
        localResource: 'loro',
        endorserId: 'admin',
        state: world,
      })
    ).toBe(false);
  });

  it('flags cursor ahead of a recoverable document and preserves lost-ACK bytes', () => {
    expect(refCursorAllowed({ hasDocument: false, docCoversCursor: false })).toBe('lost');
    expect(refCursorAllowed({ hasDocument: true, docCoversCursor: false })).toBe('ahead');
    expect(refCursorAllowed({ hasDocument: true, docCoversCursor: true })).toBe('ok');
    expect(refRetryPreservesCommit({ originalHex: 'aa', retryHex: 'aa' })).toBe(true);
    expect(refRetryPreservesCommit({ originalHex: 'aa', retryHex: 'ab' })).toBe(false);
  });
});
