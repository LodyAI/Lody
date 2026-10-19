import { describe, expect, it } from 'vitest';
import { history } from './ledger-fixture';
import {
  refContextMatches,
  refWriteExpectation,
  refSendExpectation,
  refRetryExpectation,
  refStateFromOrg,
  captureRefState,
  refCursorAllowed,
  refMayAdmit,
  refMayRecover,
  refRevokeIsLocal,
  refSnapshotAdmissible,
  type RefDevice,
  type RefState,
} from '../src/pure/reference-model';

function device(input: Partial<RefDevice> & Pick<RefDevice, 'id'>): RefDevice {
  return {
    user: 'alice',
    kind: 'personal',
    role: 'owner',
    ...input,
  };
}

function state(devices: RefDevice[], extra?: Partial<RefState>): RefState {
  return {
    org: 'org-a',
    epoch: 1,
    rotationRequired: false,
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
      device({ id: 'guest', role: 'guest', user: 'bob' }),
      device({ id: 'machine', kind: 'machine', role: 'member', user: 'alice' }),
    ]);
    expect(refMayAdmit(world, 'guest', 'org-a')).toBe(false);
    const roleBound = state([
      device({ id: 'admin-phone', role: 'admin', user: 'bob' }),
      device({ id: 'member-phone', role: 'member', user: 'carol' }),
      device({ id: 'owner-machine', kind: 'machine' }),
      device({ id: 'owner-r', kind: 'recovery' }),
    ]);
    expect(refMayAdmit(roleBound, 'admin-phone', 'org-a')).toBe(true);
    expect(refMayAdmit(roleBound, 'member-phone', 'org-a')).toBe(false);
    expect(refMayAdmit(roleBound, 'owner-machine', 'org-a')).toBe(false);
    expect(refMayAdmit(roleBound, 'owner-r', 'org-a')).toBe(false);
    expect(refWriteExpectation(world, 'guest', 'org-a', 1)).toBe('deny');
    expect(refWriteExpectation(world, 'owner', 'org-b', 1)).toBe('deny');
    expect(refWriteExpectation(world, 'owner', 'org-a', 0)).toBe('deny');
    expect(refSendExpectation(world, 'machine', 'org-a')).toBe('allow');
    expect(refSendExpectation(world, 'guest', 'org-a')).toBe('allow');
    expect(refSendExpectation(world, 'owner', 'org-a')).toBe('allow');
    expect(refSendExpectation(world, 'owner', 'org-b')).toBe('deny');
    expect(refSendExpectation(world, 'stranger', 'org-a')).toBe('deny');
    const unmeasured = state([
      { ...device({ id: 'unknown' }), kind: undefined } as unknown as RefDevice,
    ]);
    expect(refSendExpectation(unmeasured, 'unknown', 'org-a')).toBe('unmeasured');
    const recovery = device({ id: 'r', kind: 'recovery', role: 'member' });
    expect(refSendExpectation(state([device({ id: 'owner' }), recovery]), 'r', 'org-a')).toBe(
      'deny'
    );
    const revokedMachine = state(
      [device({ id: 'owner' }), device({ id: 'machine', kind: 'machine', role: 'member' })],
      { revoked: new Set(['machine']) }
    );
    expect(refSendExpectation(revokedMachine, 'machine', 'org-a')).toBe('deny');
  });

  it('keeps recovery and revoke inside current membership', () => {
    const recovery = device({ id: 'r', kind: 'recovery', role: 'member' });
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
    expect(
      refRevokeIsLocal({ org: 'org-a', boundOrg: 'org-b', deviceId: 'same', otherDeviceId: 'same' })
    ).toEqual({ targetRevoked: false, otherUntouched: true });
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
    expect(refCursorAllowed({} as Parameters<typeof refCursorAllowed>[0])).toBe('unmeasured');
    expect(refCursorAllowed({ hasDocument: true } as Parameters<typeof refCursorAllowed>[0])).toBe(
      'unmeasured'
    );
    expect(refRetryExpectation({ originalHex: 'aa', retryHex: 'aa' })).toBe('allow');
    expect(refRetryExpectation({ originalHex: 'aa', retryHex: 'ab' })).toBe('deny');
    expect(refRetryExpectation({ originalHex: '', retryHex: '' })).toBe('unmeasured');
  });
});

describe('owned reference observations, never implementation-derived expectations', () => {
  it('blocks new seal until rotation, marks missing observations unmeasured and keeps role/context denials distinct', () => {
    const writer = device({ id: 'writer', role: 'member' });
    const ready = state([writer]);
    expect(refWriteExpectation(ready, 'writer', 'org-a', 1)).toBe('allow');
    const blocked = state([writer], { rotationRequired: true });
    expect(refWriteExpectation(blocked, 'writer', 'org-a', 1)).toBe('deny');
    const unknown = state([writer], { rotationRequired: undefined });
    expect(refWriteExpectation(unknown, 'writer', 'org-a', 1)).toBe('unmeasured');
    expect(refWriteExpectation(unknown, 'writer', 'org-b', 1)).toBe('deny');
    expect(refWriteExpectation(ready, 'writer', 'org-a', NaN)).toBe('unmeasured');
    // Snapshot eligibility is deliberately independent of new-seal rotation.
    const manager = state([device({ id: 'admin', role: 'admin' })], { rotationRequired: true });
    expect(
      refSnapshotAdmissible({
        snapshotOrg: 'org-a',
        localOrg: 'org-a',
        snapshotResource: 'loro',
        localResource: 'loro',
        endorserId: 'admin',
        state: manager,
      })
    ).toBe(true);
  });
  it('owns factual rows/collections and exposes no mutation path through returned iterators or forEach', () => {
    const row = device({ id: 'writer', role: 'member' });
    const input = state([row]);
    const owned = captureRefState(input);
    (row as { role: string }).role = 'guest';
    (input.devices as Map<string, RefDevice>).clear();
    (input.revoked as Set<string>).add('writer');
    expect(refWriteExpectation(owned, 'writer', 'org-a', 1)).toBe('allow');
    expect(Reflect.set(owned.devices.get('writer')!, 'role', 'guest')).toBe(false);
    owned.devices.forEach((value, key, collection) => {
      expect(key).toBe('writer');
      expect(value.role).toBe('member');
      expect(collection).toBe(owned.devices);
      expect('set' in collection).toBe(false);
    });
    const entries = [...owned.devices];
    entries[0]![0] = 'other';
    expect(owned.devices.has('writer')).toBe(true);
    expect('add' in owned.revoked).toBe(false);
    expect(Reflect.set(owned, 'rotationRequired', true)).toBe(false);
  });
  it('maps independently verified public ledger facts including rotation without calling a policy for expected permission', () => {
    const f = history();
    const source = f.view.inspectState();
    const derived = refStateFromOrg('org-a', source);
    expect(derived.epoch).toBe(source.epoch.number);
    expect(derived.rotationRequired).toBe(source.epoch.rotationRequired);
    const ownerId = Buffer.from(f.owner.publicKey.toBytes()).toString('hex');
    expect(derived.devices.get(ownerId)?.role).toBe('owner');
    expect(derived.ownerUser).toBe(
      Buffer.from(
        source.members.get(Buffer.from(source.owner.toBytes()).toString('hex'))!.userId.toBytes()
      ).toString('hex')
    );
    // This checks only the fact adapter, not policy agreement against core.
    const rotated = refStateFromOrg('org-a', {
      ...source,
      epoch: { ...source.epoch, rotationRequired: true },
    });
    expect(refWriteExpectation(rotated, ownerId, 'org-a', source.epoch.number)).toBe('deny');
  });
});
