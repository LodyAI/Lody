import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ControlLogClient,
  ControlFreshnessLease,
  WebCryptoControl,
  decodeRecord,
  encodeRecord,
  signingBytes,
  deriveTeamAnchor,
  encodeTeamAction,
  decodeTeamAction,
  encodeTeamGenesis,
  replayChain,
  ownerManagedTeamPolicy,
  listTeamRecipients,
  fromHex,
  toHex,
  type TeamAction,
  type TeamDeviceInput,
  type TeamGenesis,
  type TeamMemberInput,
  type TeamState,
  type ControlEvent,
  type TrustAnchor,
  type ChainSnapshot,
  commitEpochKey,
  VerifiedEpochKeys,
  KeyEnvelopeCipher,
  OrgKeyExchange,
  type KeyEnvelopeContext,
  signJoinRequest,
  verifyJoinRequest,
  assertJoinRequestFresh,
  type JoinRequest,
} from '../src';
import { MemoryStore, MemoryStream, deferred } from './control-fixtures';

const crypto = new WebCryptoControl();
const privateKeys = new Map<string, CryptoKey>();
const encryptionPairs = new Map<string, CryptoKeyPair>();
const members = new Map<string, TeamMemberInput>();
const devices = new Map<string, TeamDeviceInput>();

async function signingKey(): Promise<string> {
  const pair = (await globalThis.crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const key = toHex(
    new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  );
  privateKeys.set(key, pair.privateKey);
  return key;
}
async function encryptionKey(): Promise<string> {
  const pair = (await globalThis.crypto.subtle.generateKey('X25519', false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicKey = toHex(
    new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  );
  encryptionPairs.set(publicKey, pair);
  return publicKey;
}
async function makeDevice(
  id: string,
  kind: TeamDeviceInput['kind'] = 'personal'
): Promise<TeamDeviceInput> {
  const device: TeamDeviceInput = {
    id,
    kind,
    canManage: kind === 'personal',
    signingKey: await signingKey(),
    encryptionKey: await encryptionKey(),
  };
  devices.set(id, device);
  return device;
}
beforeAll(async () => {
  for (const userId of ['A', 'B', 'C', 'D', 'E', 'constructor']) {
    members.set(userId, {
      userId,
      instance: `${userId}1`,
      recoverySigningKey: await signingKey(),
      recoveryEncryptionKey: await encryptionKey(),
      device: await makeDevice(`${userId}-desktop`),
    });
  }
  for (const id of ['child', 'grandchild', 'phone', 'fresh', 'other']) await makeDevice(id);
  await makeDevice('machine', 'machine');
});

function genesis(): TeamGenesis {
  return {
    nonce: '01'.repeat(32),
    owner: members.get('A')!,
  };
}
type ActionInput = TeamAction extends infer A
  ? A extends TeamAction
    ? Omit<A, 'configVersion'> & { configVersion?: number }
    : never
  : never;
type KeySlot = { id: string; publicKey: string };
function signedSlots(slots: KeySlot[]) {
  return slots.map(({ id, publicKey }) => ({ id, key: privateKeys.get(publicKey)! }));
}

/** Independent test-side signer plan. Never asks the implementation which signatures it needs. */
function expectedSlots(
  state: TeamState,
  actorId: string,
  deviceId: string,
  action: ActionInput
): KeySlot[] {
  const actor = state.members.get(actorId)!;
  const result = [{ id: 'actor-device', publicKey: actor.devices.get(deviceId)!.signingKey }];
  if (action.type === 'member.add')
    result.push(
      { id: 'joining-identity', publicKey: action.member.recoverySigningKey },
      { id: 'new-device', publicKey: action.member.device.signingKey }
    );
  if (action.type === 'device.add')
    result.push({ id: 'new-device', publicKey: action.device.signingKey });
  if (action.type === 'owner.transfer')
    result.push({
      id: 'accepting-device',
      publicKey: state.members.get(action.userId)!.devices.get(action.acceptingDevice)!.signingKey,
    });
  return result;
}

class Scenario {
  wires: string[] = [];
  snapshot: ChainSnapshot<TeamState>;
  private operation = 0;
  constructor(readonly anchor: TrustAnchor<TeamState>) {
    this.snapshot = { state: structuredClone(anchor.state), length: 0, head: anchor.genesis };
  }
  async sign(
    actor: string,
    action: ActionInput,
    options: { device?: string; instance?: string; slots?: KeySlot[]; previous?: string } = {}
  ) {
    const device = options.device ?? `${actor}-desktop`;
    const event: ControlEvent = {
      genesis: this.anchor.genesis,
      previous: options.previous ?? this.snapshot.head,
      operationId: (++this.operation).toString(16).padStart(32, '0'),
      actor,
      memberInstance: options.instance ?? this.snapshot.state.members.get(actor)!.instance,
      device,
      ...encodeTeamAction({
        ...action,
        configVersion: action.configVersion ?? this.snapshot.state.owner.configVersion,
      } as TeamAction),
    };
    return crypto.sign(
      event,
      signedSlots(options.slots ?? expectedSlots(this.snapshot.state, actor, device, action))
    );
  }
  async apply(wire: string) {
    const snapshot = await replayChain(this.anchor, [...this.wires, wire], ownerManagedTeamPolicy);
    this.wires.push(wire);
    this.snapshot = snapshot;
    return snapshot.state;
  }
  async act(actor: string, action: ActionInput, options?: Parameters<Scenario['sign']>[2]) {
    return this.apply(await this.sign(actor, action, options));
  }
  async admit(actor: string, target: string) {
    return this.act(actor, { type: 'member.add', member: members.get(target)! });
  }
}
async function scenario() {
  return new Scenario(await deriveTeamAnchor(genesis()));
}
async function team() {
  const s = await scenario();
  await s.admit('A', 'B');
  await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'admin' });
  await s.admit('A', 'C');
  await s.admit('A', 'D');
  return s;
}
function transfer(userId: string): ActionInput {
  return {
    type: 'owner.transfer',
    userId,
    instance: `${userId}1`,
    acceptingDevice: `${userId}-desktop`,
  };
}

async function joinRequest(s: Scenario, patch: Partial<JoinRequest> = {}) {
  const input: JoinRequest = {
    genesis: s.anchor.genesis,
    requestId: 'd1'.repeat(16),
    approver: { userId: 'B', instance: 'B1' },
    expiresAt: 1000,
    member: members.get('E')!,
    ...patch,
  };
  const wire = await signJoinRequest(input, {
    identity: privateKeys.get(input.member.recoverySigningKey)!,
    device: privateKeys.get(input.member.device.signingKey)!,
  });
  return { input, wire };
}

describe('detached joining consent', () => {
  it('captures consent before async signing and rejects wrong handles or implicit expiry', async () => {
    const s = await team();
    const { input } = await joinRequest(s);
    const mutable = structuredClone(input);
    const keys = {
      identity: privateKeys.get(input.member.recoverySigningKey)!,
      device: privateKeys.get(input.member.device.signingKey)!,
    };
    const pending = signJoinRequest(mutable, keys);
    Object.assign(mutable, { expiresAt: null, requestId: 'ee'.repeat(16) });
    Object.assign(mutable.member.device, { canManage: false });
    keys.device = privateKeys.get(members.get('A')!.device.signingKey)!;
    expect(await verifyJoinRequest(await pending, s.anchor.genesis)).toEqual(input);
    await expect(signJoinRequest(input, keys)).rejects.toThrow('bad-consent-signature');
    for (const expiresAt of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(joinRequest(s, { expiresAt } as Partial<JoinRequest>)).rejects.toThrow(
        'invalid-join-expiry'
      );
    }
    const perpetual = await joinRequest(s, { expiresAt: null });
    const verified = await verifyJoinRequest(perpetual.wire, s.anchor.genesis);
    expect(() => assertJoinRequestFresh(verified, Number.MAX_SAFE_INTEGER)).not.toThrow();
    for (const malformed of [` ${perpetual.wire}`, perpetual.wire + '\n', 'x'.repeat(4097)]) {
      await expect(verifyJoinRequest(malformed, s.anchor.genesis)).rejects.toThrow();
    }
  });

  it('accepts one immutable request after unrelated head changes without the applicant signing again', async () => {
    const s = await team();
    const { input, wire } = await joinRequest(s);
    expect(await verifyJoinRequest(wire, s.anchor.genesis)).toEqual(input);
    await s.act('A', { type: 'device.add', device: devices.get('phone')! });
    await s.act('A', transfer('C'));
    const approval = await s.sign('B', { type: 'member.admit', request: wire });
    expect(decodeRecord(approval).signatures.map(([id]) => id)).toEqual(['actor-device']);
    await s.apply(approval);
    expect(s.snapshot.state.members.get('E')!.role).toBe('member');
    expect(s.snapshot.state.members.get('E')!.devices.get('E-desktop')).toEqual(
      input.member.device
    );
    expect((await replayChain(s.anchor, s.wires, ownerManagedTeamPolicy)).state).toEqual(
      s.snapshot.state
    );
  });

  it('verifies both detached signatures even when a valid Admin signs the outer approval', async () => {
    const s = await team();
    const { wire } = await joinRequest(s);
    for (const index of [1, 2]) {
      const parts = JSON.parse(wire) as string[];
      parts[index] = '00'.repeat(64);
      const forged = JSON.stringify(parts);
      await expect(verifyJoinRequest(forged, s.anchor.genesis)).rejects.toThrow(
        'bad-consent-signature'
      );
      await expect(s.act('B', { type: 'member.admit', request: forged })).rejects.toThrow(
        'bad-consent-signature'
      );
      expect(s.snapshot.state.members.has('E')).toBe(false);
      expect(s.snapshot.state.closedJoinRequests.size).toBe(0);
    }
    const approval = await s.sign('B', { type: 'member.admit', request: wire });
    const decoded = decodeRecord(approval);
    await expect(
      s.apply(encodeRecord({ ...decoded, signatures: [['actor-device', '00'.repeat(64)]] }))
    ).rejects.toThrow('bad-signature');
    expect(s.snapshot.state.members.has('E')).toBe(false);
  });

  it('binds Org, approver instance, applicant keys and expiry; a directory cannot replace the consent', async () => {
    const s = await team();
    const { wire } = await joinRequest(s);
    await expect(verifyJoinRequest(wire, 'ff'.repeat(32))).rejects.toThrow('wrong-join-org');
    await expect(s.act('A', { type: 'member.admit', request: wire })).rejects.toThrow(
      'wrong-join-approver'
    );
    for (const patch of [
      { genesis: 'ff'.repeat(32) },
      { approver: { userId: 'B', instance: 'B2' } },
    ]) {
      const foreign = await joinRequest(s, patch);
      await expect(s.act('B', { type: 'member.admit', request: foreign.wire })).rejects.toThrow();
    }
    const changed = await joinRequest(s, {
      member: { ...members.get('E')!, device: devices.get('fresh')! },
    });
    const original = JSON.parse(wire) as string[];
    original[0] = (JSON.parse(changed.wire) as string[])[0]!;
    await expect(
      s.act('B', { type: 'member.admit', request: JSON.stringify(original) })
    ).rejects.toThrow('bad-consent-signature');
    const expiry = JSON.parse(wire) as string[];
    const body = JSON.parse(expiry[0]!) as string[];
    body[5] = '2000';
    expiry[0] = JSON.stringify(body);
    await expect(
      s.act('B', { type: 'member.admit', request: JSON.stringify(expiry) })
    ).rejects.toThrow('bad-consent-signature');
  });

  it.each(['demotion', 'device-revocation', 'member-removal'])(
    'rejects approval after approver %s',
    async (reason) => {
      const s = await team();
      const { wire } = await joinRequest(s);
      const old = await s.sign('B', { type: 'member.admit', request: wire });
      if (reason === 'demotion')
        await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'member' });
      else if (reason === 'device-revocation')
        await s.act('B', { type: 'device.revoke', deviceId: 'B-desktop' });
      else await s.act('A', { type: 'member.remove', userId: 'B', instance: 'B1' });
      await expect(s.apply(old)).rejects.toThrow('wrong-parent');
      const fresh = await s.sign(
        'B',
        { type: 'member.admit', request: wire },
        {
          instance: 'B1',
          slots: [{ id: 'actor-device', publicKey: members.get('B')!.device.signingKey }],
        }
      );
      await expect(s.apply(fresh)).rejects.toThrow();
      expect(s.snapshot.state.members.has('E')).toBe(false);
    }
  );

  it.each(['approve', 'cancel'])(
    'orders cancellation and approval by CAS, with %s first',
    async (winner) => {
      const s = await team();
      const { wire } = await joinRequest(s);
      const approval = await s.sign('B', { type: 'member.admit', request: wire });
      const cancelOptions = {
        instance: 'E1',
        slots: [{ id: 'actor-device', publicKey: members.get('E')!.device.signingKey }],
      };
      const cancel = await s.sign('E', { type: 'member.cancel', request: wire }, cancelOptions);
      const stream = new MemoryStream();
      for (const record of s.wires) stream.append(stream.tail, record);
      const first = new ControlLogClient(
        s.anchor,
        ownerManagedTeamPolicy,
        new MemoryStore(),
        stream
      );
      const second = new ControlLogClient(
        s.anchor,
        ownerManagedTeamPolicy,
        new MemoryStore(),
        stream
      );
      expect((await first.submit(winner === 'approve' ? approval : cancel)).status).toBe(
        'committed'
      );
      expect((await second.submit(winner === 'approve' ? cancel : approval)).status).toBe(
        'conflict'
      );
      const snapshot = await second.read();
      expect(snapshot.state.members.has('E')).toBe(winner === 'approve');
      s.wires = stream.rows.map((r) => r.wire);
      s.snapshot = snapshot;
      const freshLoser =
        winner === 'approve'
          ? await s.sign('E', { type: 'member.cancel', request: wire }, cancelOptions)
          : await s.sign('B', { type: 'member.admit', request: wire });
      await expect(second.submit(freshLoser)).rejects.toThrow('join-request-closed');
      expect((await second.read()).state.members.has('E')).toBe(winner === 'approve');
    }
  );

  it('does not let another identity cancel a guessed request ID or re-admit a consumed request', async () => {
    const s = await team();
    const { wire } = await joinRequest(s);
    const other = await joinRequest(s, { member: { ...members.get('D')!, instance: 'D-next' } });
    await s.act(
      'D',
      { type: 'member.cancel', request: other.wire },
      {
        instance: 'D-next',
        slots: [{ id: 'actor-device', publicKey: members.get('D')!.device.signingKey }],
      }
    );
    await s.act('B', { type: 'member.admit', request: wire });
    await s.act('A', { type: 'member.remove', userId: 'E', instance: 'E1' });
    await expect(s.act('B', { type: 'member.admit', request: wire })).rejects.toThrow(
      'join-request-closed'
    );
    const recycled = await joinRequest(s, { member: { ...members.get('E')!, instance: 'E2' } });
    await expect(s.act('B', { type: 'member.admit', request: recycled.wire })).rejects.toThrow(
      'join-request-closed'
    );
    const fresh = await joinRequest(s, {
      requestId: 'd2'.repeat(16),
      member: { ...members.get('E')!, instance: 'E2' },
    });
    await s.act('B', { type: 'member.admit', request: fresh.wire });
    expect(s.snapshot.state.members.get('E')!.instance).toBe('E2');
  });

  it('checks expiry at admission, not against the wall clock when replaying historical membership', async () => {
    const s = await team();
    const { input, wire } = await joinRequest(s);
    assertJoinRequestFresh(input, 999);
    expect(() => assertJoinRequestFresh(input, 1000)).toThrow('join-request-expired');
    expect(() => assertJoinRequestFresh(input, NaN)).toThrow('invalid-admission-time');
    const approval = await s.sign('B', { type: 'member.admit', request: wire });
    for (const admissionTime of [999, 1000]) {
      const stream = new MemoryStream();
      for (const record of s.wires) stream.append(stream.tail, record);
      let now = admissionTime;
      // Synthetic trusted admission boundary; production must enforce this atomically too.
      stream.onAppend = async (offset, record) => {
        const action = decodeTeamAction(decodeRecord(record).event);
        if (action.type === 'member.admit') {
          const request = await verifyJoinRequest(action.request, s.anchor.genesis);
          assertJoinRequestFresh(request, now);
        }
        return stream.append(offset, record);
      };
      const store = new MemoryStore();
      const client = new ControlLogClient(s.anchor, ownerManagedTeamPolicy, store, stream);
      expect((await client.submit(approval)).status).toBe(
        admissionTime < 1000 ? 'committed' : 'unknown'
      );
      now = 2000;
      const restarted = new ControlLogClient(s.anchor, ownerManagedTeamPolicy, store, stream);
      if (admissionTime === 1000) {
        expect((await restarted.resume()).status).toBe('unknown');
        expect(store.journal!.pending).toBe(approval);
      }
      expect((await restarted.read()).state.members.has('E')).toBe(admissionTime < 1000);
      expect(stream.rows).toHaveLength(s.wires.length + (admissionTime < 1000 ? 1 : 0));
    }
  });
});

describe('verified Org key exchange', () => {
  async function fixture() {
    const s = await team();
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const digest = await commitEpochKey(s.anchor.genesis, secret);
    await s.act('B', { type: 'epoch.publish', epoch: 0, commitment: digest });
    const stream = new MemoryStream();
    const sync = () => {
      for (const record of s.wires.slice(stream.rows.length)) stream.append(stream.tail, record);
    };
    sync();
    let fresh = true;
    const exchange = () =>
      new OrgKeyExchange(s.anchor, new MemoryStore(), stream, () => {
        if (!fresh) throw new Error('stale-key-session');
      });
    const sender = { actor: 'B', memberInstance: 'B1', device: 'B-desktop' };
    const recipient = {
      kind: 'device' as const,
      actor: 'E',
      memberInstance: 'E1',
      id: 'E-desktop',
    };
    const input = {
      epoch: 0,
      sender,
      recipient,
      secret,
      signingKey: privateKeys.get(members.get('B')!.device.signingKey)!,
    };
    const keys = encryptionPairs.get(members.get('E')!.device.encryptionKey)!;
    const admit = async () => {
      const request = await joinRequest(s);
      await s.act('B', { type: 'member.admit', request: request.wire });
      sync();
    };
    return {
      s,
      secret,
      digest,
      stream,
      sync,
      exchange,
      input,
      keys,
      admit,
      expire: () => {
        fresh = false;
      },
    };
  }

  it('enforces a fixed lease on real key preparation, reception and deferred dispatch', async () => {
    const f = await fixture();
    await f.admit();
    let now = 1000;
    const observation = {
      genesis: f.s.anchor.genesis,
      head: f.s.snapshot.head,
      length: f.s.snapshot.length,
      observedAt: 1000,
      expiresAt: 901000,
    };
    const lease = new ControlFreshnessLease(f.s.anchor.genesis, observation, () => now);
    const exchange = new OrgKeyExchange(f.s.anchor, new MemoryStore(), f.stream, (snapshot) =>
      lease.assert(snapshot)
    );
    const prepared = await exchange.prepare(f.input);
    const received = await exchange.open(prepared.context, prepared.frame, f.keys);
    expect(received).toEqual(f.secret);
    received.fill(0);
    const dispatch = await exchange.authorizeDispatch(prepared.frame);
    now = 901000;
    expect(dispatch).toThrow('freshness-expired');
    await expect(exchange.prepare(f.input)).rejects.toThrow('freshness-invalidated');
    await expect(exchange.open(prepared.context, prepared.frame, f.keys)).rejects.toThrow(
      'freshness-invalidated'
    );
    expect(() => new ControlFreshnessLease(f.s.anchor.genesis, observation, () => now)).toThrow(
      'freshness-expired'
    );
  });

  it('sends only after verified admission and opens a delayed envelope after sender demotion', async () => {
    const f = await fixture();
    const sender = f.exchange();
    await expect(sender.prepare(f.input)).rejects.toThrow('inactive-key-recipient');
    await f.admit();
    const prepared = await sender.prepare(f.input);
    await f.s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'member' });
    f.sync();
    await expect(sender.prepare(f.input)).rejects.toThrow('key-sender-role-required');
    const received = await f.exchange().open(prepared.context, prepared.frame, f.keys);
    expect(received).toEqual(f.secret);
    const keyring = new VerifiedEpochKeys(f.s.anchor.genesis, { commitment: () => f.digest });
    await keyring.install(0, received);
    received.fill(0);
    expect(keyring.read(0)).toEqual(f.secret);
    keyring.clear();
  });

  it('rejects revoked recipients, invented heads and expired sessions, without accepting a stale approval', async () => {
    const f = await fixture();
    await f.admit();
    const prepared = await f.exchange().prepare(f.input);
    await expect(
      f
        .exchange()
        .open({ ...prepared.context, controlHead: 'ef'.repeat(32) }, prepared.frame, f.keys)
    ).rejects.toThrow('unknown-key-control-head');
    await f.s.act('E', { type: 'device.revoke', deviceId: 'E-desktop' });
    f.sync();
    await expect(f.exchange().open(prepared.context, prepared.frame, f.keys)).rejects.toThrow(
      'inactive-key-recipient'
    );
    await expect(f.exchange().prepare(f.input)).rejects.toThrow('inactive-key-recipient');
    f.expire();
    await expect(f.exchange().open(prepared.context, prepared.frame, f.keys)).rejects.toThrow(
      'stale-key-session'
    );
  });

  it('rejects a valid Admin signature over a key that disagrees with the ledger commitment', async () => {
    const f = await fixture();
    await f.admit();
    const prepared = await f.exchange().prepare(f.input);
    const wrong = new Uint8Array(32).fill(9);
    await expect(f.exchange().prepare({ ...f.input, secret: wrong })).rejects.toThrow(
      'epoch-key-mismatch'
    );
    const forged = await new KeyEnvelopeCipher({
      authorize: () => ({
        senderSigningKey: members.get('B')!.device.signingKey,
        recipientEncryptionKey: members.get('E')!.device.encryptionKey,
      }),
    }).seal(prepared.context, wrong, f.input.signingKey);
    await expect(f.exchange().open(prepared.context, forged, f.keys)).rejects.toThrow(
      'epoch-key-mismatch'
    );
  });

  it('allows a personal Member to copy to their own recovery identity, not to other members or from a machine', async () => {
    const f = await fixture();
    await f.admit();
    const own = {
      ...f.input,
      sender: { actor: 'E', memberInstance: 'E1', device: 'E-desktop' },
      recipient: { kind: 'recovery' as const, actor: 'E', memberInstance: 'E1', id: 'E' },
      signingKey: privateKeys.get(members.get('E')!.device.signingKey)!,
    };
    const prepared = await f.exchange().prepare(own);
    expect(
      await f
        .exchange()
        .open(
          prepared.context,
          prepared.frame,
          encryptionPairs.get(members.get('E')!.recoveryEncryptionKey)!
        )
    ).toEqual(f.secret);
    await expect(
      f.exchange().prepare({
        ...own,
        recipient: { kind: 'device', actor: 'D', memberInstance: 'D1', id: 'D-desktop' },
      })
    ).rejects.toThrow('key-sender-role-required');
    await f.s.act('E', { type: 'device.add', device: devices.get('machine')! });
    f.sync();
    await expect(
      f.exchange().prepare({
        ...own,
        sender: { ...own.sender, device: 'machine' },
        signingKey: privateKeys.get(devices.get('machine')!.signingKey)!,
      })
    ).rejects.toThrow('key-sender-management-required');
  });

  it('continues current-key preparation while rotation is pending, but never prepares an older published epoch', async () => {
    const f = await fixture();
    await f.admit();
    await f.s.act('A', { type: 'member.remove', userId: 'D', instance: 'D1' });
    f.sync();
    expect(f.s.snapshot.state.requiresKeyRotation).toBe(true);
    const prepared = await f.exchange().prepare(f.input);
    const next = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await f.s.act('B', {
      type: 'epoch.publish',
      epoch: 1,
      commitment: await commitEpochKey(f.s.anchor.genesis, next),
    });
    f.sync();
    await expect(f.exchange().prepare(f.input)).rejects.toThrow('not-current-epoch');
    // A delayed old envelope remains useful to this retained recipient for historical content.
    expect(await f.exchange().open(prepared.context, prepared.frame, f.keys)).toEqual(f.secret);
  });

  it.each(['open', 'prepare'] as const)(
    'rechecks %s after crypto and cancels known invalidation during catch-up',
    async (operation) => {
      const f = await fixture();
      await f.admit();
      const prepared = await f.exchange().prepare(f.input);
      const entered = deferred();
      const release = deferred();
      const originalRead = f.stream.readAfter.bind(f.stream);
      const receiver = f.exchange();
      const caughtUp = f.stream.tail;
      // A second read at the saved tail happens only after envelope crypto completes.
      const waitForTail = async (offset: string) => {
        if (offset === caughtUp) {
          entered.resolve();
          await release.promise;
        }
        f.stream.onRead = undefined;
        const page = await originalRead(offset);
        if (offset !== caughtUp) f.stream.onRead = waitForTail;
        return page;
      };
      f.stream.onRead = waitForTail;
      const opening =
        operation === 'open'
          ? receiver.open(prepared.context, prepared.frame, f.keys)
          : receiver.prepare(f.input);
      const rejected = expect(opening).rejects.toThrow('inactive-key-recipient');
      await entered.promise;
      await f.s.act('A', { type: 'member.remove', userId: 'E', instance: 'E1' });
      f.sync();
      release.resolve();
      await rejected;

      const blocked = deferred();
      const resume = deferred();
      f.stream.onRead = async (offset) => {
        blocked.resolve();
        await resume.promise;
        f.stream.onRead = undefined;
        return originalRead(offset);
      };
      const pending = receiver.open(prepared.context, prepared.frame, f.keys);
      const invalidated = expect(pending).rejects.toThrow('key-exchange-invalidated');
      await blocked.promise;
      receiver.invalidate();
      resume.resolve();
      await invalidated;
    }
  );
});

describe('Team wire and trusted genesis', () => {
  it('rejects Admin rotation after demotion or device revocation, including freshly signed requests', async () => {
    const action: ActionInput = { type: 'epoch.publish', epoch: 0, commitment: '91'.repeat(32) };
    for (const revoke of [false, true]) {
      const s = await team();
      const old = await s.sign('B', action);
      if (revoke) await s.act('B', { type: 'device.revoke', deviceId: 'B-desktop' });
      else await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'member' });
      await expect(s.apply(old)).rejects.toThrow('wrong-parent');
      const fresh = await s.sign('B', action, {
        slots: [{ id: 'actor-device', publicKey: members.get('B')!.device.signingKey }],
      });
      await expect(s.apply(fresh)).rejects.toThrow(
        revoke ? 'inactive-personal-device' : 'rotator-required'
      );
      expect(s.snapshot.state.epochs.size).toBe(0);
    }
  });

  it('binds explicit device authority in signatures and never inherits it from an Owner role', async () => {
    const s = await team();
    const limited = { ...devices.get('phone')!, canManage: false };
    const admission = await s.sign('A', { type: 'device.add', device: limited });
    const { event, signatures } = decodeRecord(admission);
    const elevated = encodeTeamAction({
      type: 'device.add',
      configVersion: 0,
      device: { ...limited, canManage: true },
    });
    await expect(
      s.apply(encodeRecord({ event: { ...event, ...elevated }, signatures }))
    ).rejects.toThrow('bad-signature');
    await s.apply(admission);
    for (const action of [
      { type: 'epoch.publish', epoch: 0, commitment: '92'.repeat(32) },
      { type: 'member.add', member: members.get('E')! },
      { type: 'device.add', device: devices.get('fresh')! },
      { type: 'device.revoke', deviceId: 'A-desktop' },
      transfer('B'),
    ] as ActionInput[]) {
      await expect(s.act('A', action, { device: limited.id })).rejects.toThrow(
        'device-management-required'
      );
    }
    await s.act('B', {
      type: 'device.add',
      device: { ...devices.get('other')!, canManage: false },
    });
    await expect(
      s.act('A', { ...transfer('B'), acceptingDevice: 'other' } as ActionInput)
    ).rejects.toThrow('device-management-required');
    await s.act('A', transfer('B'));
    await expect(
      s.act(
        'B',
        { type: 'epoch.publish', epoch: 0, commitment: '92'.repeat(32) },
        { device: 'other' }
      )
    ).rejects.toThrow('device-management-required');
  });

  it('requires explicit permissions at admission and refuses a management-capable Machine', async () => {
    const s = await scenario();
    const machine = devices.get('machine')!;
    await expect(
      s.act('A', { type: 'device.add', device: { ...machine, canManage: true } })
    ).rejects.toThrow('machine-management-forbidden');
    const encoded = encodeTeamAction({ type: 'device.add', configVersion: 0, device: machine });
    const parts = JSON.parse(new TextDecoder().decode(fromHex(encoded.payload))) as string[];
    parts[7] = 'all';
    expect(() =>
      decodeTeamAction({
        ...encoded,
        payload: toHex(new TextEncoder().encode(JSON.stringify(parts))),
      })
    ).toThrow('invalid-device-permissions');
    parts.pop();
    expect(() =>
      decodeTeamAction({
        ...encoded,
        payload: toHex(new TextEncoder().encode(JSON.stringify(parts))),
      })
    ).toThrow('invalid-team-fields');
    await expect(
      deriveTeamAnchor({
        ...genesis(),
        owner: { ...genesis().owner, device: { ...genesis().owner.device, canManage: false } },
      })
    ).rejects.toThrow('device-management-required');
  });

  it('commits only one epoch when Owner and Admin publish from the same head', async () => {
    const s = await team();
    const firstWire = await s.sign('A', {
      type: 'epoch.publish',
      epoch: 0,
      commitment: '71'.repeat(32),
    });
    const secondWire = await s.sign('B', {
      type: 'epoch.publish',
      epoch: 0,
      commitment: '72'.repeat(32),
    });
    const stream = new MemoryStream();
    for (const wire of s.wires) stream.append(stream.tail, wire);
    const first = new ControlLogClient(s.anchor, ownerManagedTeamPolicy, new MemoryStore(), stream);
    const second = new ControlLogClient(
      s.anchor,
      ownerManagedTeamPolicy,
      new MemoryStore(),
      stream
    );
    const entered = deferred();
    const release = deferred();
    stream.onAppend = async (offset, wire) => {
      if (wire === secondWire) {
        entered.resolve();
        await release.promise;
      }
      return stream.append(offset, wire);
    };
    const losing = second.submit(secondWire);
    await entered.promise;
    try {
      expect((await first.submit(firstWire)).status).toBe('committed');
    } finally {
      release.resolve();
    }
    expect((await losing).status).toBe('conflict');
    expect([...(await second.read()).state.epochs.entries()]).toEqual([[0, '71'.repeat(32)]]);
  });
  it('installs only keys matching the verified Owner publication and denies a removed recipient', async () => {
    const s = await team();
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const commitment = await commitEpochKey(s.anchor.genesis, secret);
    const keys = new VerifiedEpochKeys(s.anchor.genesis, {
      commitment(epoch) {
        const member = s.snapshot.state.members.get('C');
        if (member?.instance !== 'C1' || !member.devices.has('C-desktop'))
          throw new Error('recipient-revoked');
        const result = s.snapshot.state.epochs.get(epoch);
        if (result === undefined) throw new Error('unpublished-epoch');
        return result;
      },
    });
    await expect(keys.install(0, secret)).rejects.toThrow('unpublished-epoch');
    await s.act('A', { type: 'epoch.publish', epoch: 0, commitment });
    await expect(keys.install(0, new Uint8Array(32))).rejects.toThrow('epoch-key-mismatch');
    const context: KeyEnvelopeContext = {
      genesis: s.anchor.genesis,
      epoch: 0,
      controlHead: s.snapshot.head,
      sender: { actor: 'B', memberInstance: 'B1', device: 'B-desktop' },
      recipient: { kind: 'device', actor: 'C', memberInstance: 'C1', id: 'C-desktop' },
    };
    // Real replayed Org state supplies keys; neither a header claim nor a directory does.
    const envelopes = new KeyEnvelopeCipher({
      authorize(value) {
        const admin = s.snapshot.state.members.get('B');
        const recipient = listTeamRecipients(s.snapshot.state).find(
          (r) => r.userId === 'C' && r.kind === 'device' && r.id === 'C-desktop'
        );
        if (value.controlHead !== s.snapshot.head || admin?.role !== 'admin' || !recipient)
          throw new Error('delivery-denied');
        return {
          senderSigningKey: admin.devices.get('B-desktop')!.signingKey,
          recipientEncryptionKey: recipient.encryptionKey,
        };
      },
    });
    const recipientPair = encryptionPairs.get(members.get('C')!.device.encryptionKey)!;
    const sealed = await envelopes.seal(
      context,
      secret,
      privateKeys.get(members.get('B')!.device.signingKey)!
    );
    const received = await envelopes.open(context, recipientPair, sealed);
    try {
      await keys.install(0, received);
    } finally {
      received.fill(0);
    }
    expect(keys.read(0)).toEqual(secret);
    await s.act('A', { type: 'member.remove', userId: 'C', instance: 'C1' });
    await expect(envelopes.open(context, recipientPair, sealed)).rejects.toThrow('delivery-denied');
    expect(() => keys.read(0)).toThrow('recipient-revoked');
    keys.clear();
  });
  it('allows Owner and Admin, but not Members, to publish consecutive non-reused epochs', async () => {
    const s = await team();
    const action: ActionInput = { type: 'epoch.publish', epoch: 0, commitment: '81'.repeat(32) };
    await expect(s.act('C', action)).rejects.toThrow('rotator-required');
    await expect(s.act('A', { ...action, epoch: 1 })).rejects.toThrow('nonconsecutive-epoch');
    await s.act('A', action);
    expect(s.snapshot.state.epochs.get(0)).toBe(action.commitment);
    await expect(s.act('A', action)).rejects.toThrow('nonconsecutive-epoch');
    await expect(s.act('A', { ...action, epoch: 1 })).rejects.toThrow('epoch-key-reused');
    await s.act('A', { type: 'member.remove', userId: 'C', instance: 'C1' });
    expect(s.snapshot.state.requiresKeyRotation).toBe(true);
    await s.act('B', { ...action, epoch: 1, commitment: '82'.repeat(32) });
    expect(s.snapshot.state.requiresKeyRotation).toBe(false);
    expect([...s.snapshot.state.epochs.values()]).toEqual(['81'.repeat(32), '82'.repeat(32)]);
  });

  it('does not accept an old-head epoch publication across a revocation or Owner transfer', async () => {
    const s = await team();
    const action: ActionInput = { type: 'epoch.publish', epoch: 0, commitment: '83'.repeat(32) };
    const old = await s.sign('A', action);
    await s.act('C', { type: 'device.revoke', deviceId: 'C-desktop' });
    await expect(s.apply(old)).rejects.toThrow('wrong-parent');
    expect(s.snapshot.state.requiresKeyRotation).toBe(true);
    await s.act('A', action);
    await s.act('A', transfer('B'));
    await s.act('A', { ...action, epoch: 1, commitment: '84'.repeat(32) });
    expect(s.snapshot.state.epochs.size).toBe(2);
  });

  it('rejects weak device and identity signing keys at genesis', async () => {
    const weak = '01' + '00'.repeat(31);
    const input = genesis();
    for (const candidate of [
      { ...input, owner: { ...input.owner, recoverySigningKey: weak } },
      { ...input, owner: { ...input.owner, device: { ...input.owner.device, signingKey: weak } } },
    ]) {
      await expect(deriveTeamAnchor(candidate)).rejects.toThrow();
    }
  });

  it('rejects admission of a device with a public forged possession signature', async () => {
    const s = await scenario();
    const { event: original } = decodeRecord(
      await s.sign('A', {
        type: 'device.add',
        device: devices.get('phone')!,
      })
    );
    // Simulate untrusted wire directly, bypassing any local key-generation/encoding checks.
    const fields = JSON.parse(new TextDecoder().decode(fromHex(original.payload))) as string[];
    fields[4] = '01' + '00'.repeat(31);
    const event = { ...original, payload: toHex(new TextEncoder().encode(JSON.stringify(fields))) };
    const message = signingBytes(event, ['actor-device', 'new-device']);
    const authorizerSignature = toHex(
      new Uint8Array(
        await globalThis.crypto.subtle.sign(
          'Ed25519',
          privateKeys.get(members.get('A')!.device.signingKey)!,
          message
        )
      )
    );
    const wire = encodeRecord({
      event,
      signatures: [
        ['actor-device', authorizerSignature],
        ['new-device', '01' + '00'.repeat(63)],
      ],
    });
    await expect(s.apply(wire)).rejects.toThrow('invalid-signing-key');
    expect(s.snapshot.state.members.get('A')!.devices.has('phone')).toBe(false);
  });

  it('checks every new signing-key slot when decoding untrusted Team actions', () => {
    const member = encodeTeamAction({
      type: 'member.add',
      configVersion: 0,
      member: members.get('B')!,
    });
    const device = encodeTeamAction({
      type: 'device.add',
      configVersion: 0,
      device: devices.get('phone')!,
    });
    for (const [encoded, slot] of [
      [member, 5],
      [member, 8],
      [device, 4],
    ] as const) {
      const parts = JSON.parse(new TextDecoder().decode(fromHex(encoded.payload))) as string[];
      parts[slot] = '01' + '00'.repeat(31);
      const payload = toHex(new TextEncoder().encode(JSON.stringify(parts)));
      expect(() => decodeTeamAction({ ...encoded, payload })).toThrow('invalid-signing-key');
    }
  });

  it('binds the entire public genesis and copies inputs before asynchronous hashing', async () => {
    const input = structuredClone(genesis());
    const expected = JSON.stringify([
      'lody-team-genesis/v3',
      input.nonce,
      input.owner.userId,
      input.owner.instance,
      input.owner.recoverySigningKey,
      input.owner.recoveryEncryptionKey,
      input.owner.device.id,
      input.owner.device.signingKey,
      input.owner.device.encryptionKey,
      input.owner.device.kind,
      'manage',
    ]);
    expect(encodeTeamGenesis(input)).toBe(expected);
    const pending = deriveTeamAnchor(input);
    (input.owner as { userId: string }).userId = 'mutated';
    const anchor = await pending;
    expect(anchor.genesis).toBe(createHash('sha256').update(expected).digest('hex'));
    expect([...anchor.state.members.keys()]).toEqual(['A']);
    expect((await deriveTeamAnchor({ ...genesis(), nonce: '04'.repeat(32) })).genesis).not.toBe(
      anchor.genesis
    );
    await expect(
      deriveTeamAnchor({
        ...genesis(),
        owner: { ...genesis().owner, recoverySigningKey: genesis().owner.device.signingKey },
      })
    ).rejects.toThrow('team-key-reused');
  });

  it('round-trips every action through the real signed envelope', async () => {
    const actions: ActionInput[] = [
      { type: 'member.add', member: members.get('B')! },
      { type: 'member.remove', userId: 'B', instance: 'B1' },
      { type: 'member.role', userId: 'B', instance: 'B1', role: 'admin' },
      { type: 'device.add', device: devices.get('phone')! },
      { type: 'device.revoke', deviceId: 'child' },
      transfer('B'),
    ];
    for (const action of actions) {
      const complete = { ...action, configVersion: 0 } as TeamAction;
      const encoded = encodeTeamAction(complete);
      expect(decodeTeamAction(encoded)).toEqual(complete);
      const event: ControlEvent = {
        ...encoded,
        genesis: '01'.repeat(32),
        previous: '01'.repeat(32),
        actor: 'A',
        device: 'A-desktop',
        memberInstance: 'A1',
        operationId: '01'.repeat(16),
      };
      const wire = await crypto.sign(
        event,
        signedSlots([{ id: 'actor-device', publicKey: members.get('A')!.device.signingKey }])
      );
      expect(decodeRecord(wire).event).toEqual(event);
    }
  });

  it.each(['v1', 'v2'])(
    'rejects signed %s actions under a v3 anchor and rejects relabelled signatures',
    async (legacy) => {
      const s = await team();
      const action: ActionInput = {
        type: 'member.role',
        userId: 'B',
        instance: 'B1',
        role: 'member',
      };
      const { event } = decodeRecord(await s.sign('A', action));
      const parts = JSON.parse(new TextDecoder().decode(fromHex(event.payload))) as string[];
      parts[0] = `lody-team-action/${legacy}`;
      const old = await crypto.sign(
        { ...event, payload: toHex(new TextEncoder().encode(JSON.stringify(parts))) },
        signedSlots(expectedSlots(s.snapshot.state, 'A', 'A-desktop', action))
      );
      await expect(s.apply(old)).rejects.toThrow('unsupported-team-version');
      await expect(
        s.apply(encodeRecord({ event, signatures: decodeRecord(old).signatures }))
      ).rejects.toThrow('bad-signature');
      expect(s.snapshot.state.members.get('B')!.role).toBe('admin');

      for (const type of ['device.add', 'device.revoke'] as const) {
        const encoded = encodeTeamAction(
          type === 'device.add'
            ? { type, configVersion: 0, device: devices.get('phone')! }
            : { type, configVersion: 0, deviceId: 'A-desktop' }
        );
        const fields = JSON.parse(new TextDecoder().decode(fromHex(encoded.payload))) as string[];
        fields.splice(3, 0, 'identity');
        expect(() =>
          decodeTeamAction({
            ...encoded,
            payload: toHex(new TextEncoder().encode(JSON.stringify(fields))),
          })
        ).toThrow('invalid-team-fields');
      }
    }
  );

  it('rejects malformed, aliased, extra and unknown action fields', () => {
    const valid = encodeTeamAction({
      type: 'member.role',
      configVersion: 0,
      userId: 'B',
      instance: 'B1',
      role: 'admin',
    });
    const text = new TextDecoder().decode(fromHex(valid.payload));
    for (const invalid of [
      ' ' + text,
      text.replace('"0"', '"00"'),
      text.replace('"0"', '"9007199254740992"'),
      text.replace('"admin"', '"owner"'),
      text.replace('"B"', '"\\u0042"'),
      text.replace('v3', 'v1'),
      text.slice(0, -1) + ',"extra"]',
      '[null]',
      '[]',
    ]) {
      expect(() =>
        decodeTeamAction({ ...valid, payload: toHex(new TextEncoder().encode(invalid)) })
      ).toThrow();
    }
    expect(() => decodeTeamAction({ ...valid, kind: 'team-member-remove' })).toThrow();
    expect(() => decodeTeamAction({ ...valid, payload: 'ff' })).toThrow();
    expect(() => decodeTeamAction({ ...valid, payload: '00'.repeat(4097) })).toThrow();
  });
});

describe('member, device and Owner authority', () => {
  it.each(['A-desktop', 'child', 'grandchild', 'phone'])(
    'lets own personal device %s revoke only the target, irrespective of who admitted it',
    async (revoker) => {
      const s = await scenario();
      await s.act('A', { type: 'device.add', device: devices.get('child')! });
      await s.act(
        'A',
        { type: 'device.add', device: devices.get('grandchild')! },
        { device: 'child' }
      );
      await s.act('A', { type: 'device.add', device: devices.get('phone')! });
      const recovery = listTeamRecipients(s.snapshot.state).filter((r) => r.kind === 'recovery');
      const stale = await s.sign('A', { type: 'device.add', device: devices.get('fresh')! });
      await s.act('A', { type: 'device.revoke', deviceId: 'A-desktop' }, { device: revoker });
      expect([...s.snapshot.state.members.get('A')!.devices.keys()]).toEqual([
        'child',
        'grandchild',
        'phone',
      ]);
      expect(
        listTeamRecipients(s.snapshot.state)
          .filter((r) => r.kind === 'device')
          .map((r) => r.id)
      ).toEqual(['child', 'grandchild', 'phone']);
      expect(listTeamRecipients(s.snapshot.state).filter((r) => r.kind === 'recovery')).toEqual(
        recovery
      );
      expect(s.snapshot.state.requiresKeyRotation).toBe(true);
      await expect(s.apply(stale)).rejects.toThrow('wrong-parent');
      await expect(
        s.act(
          'A',
          { type: 'device.add', device: devices.get('fresh')! },
          {
            slots: [
              { id: 'actor-device', publicKey: members.get('A')!.device.signingKey },
              { id: 'new-device', publicKey: devices.get('fresh')!.signingKey },
            ],
          }
        )
      ).rejects.toThrow('inactive-personal-device');
      await s.act(
        'A',
        { type: 'device.add', device: devices.get('fresh')! },
        { device: 'grandchild' }
      );
      await s.act('A', { type: 'device.revoke', deviceId: 'child' }, { device: 'phone' });
      expect([...s.snapshot.state.members.get('A')!.devices.keys()]).toEqual([
        'grandchild',
        'phone',
        'fresh',
      ]);
    }
  );

  it('applies user promotion and demotion to every existing personal device without Owner participation in Admin admission', async () => {
    const s = await scenario();
    await s.admit('A', 'B');
    await s.act('B', { type: 'device.add', device: devices.get('child')! });
    const invite: ActionInput = { type: 'member.add', member: members.get('C')! };
    for (const device of ['B-desktop', 'child'])
      await expect(s.act('B', invite, { device })).rejects.toThrow('inviter-required');
    await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'admin' });
    for (const device of ['B-desktop', 'child']) {
      const wire = await s.sign('B', invite, { device });
      expect(decodeRecord(wire).signatures.map(([id]) => id)).toEqual([
        'actor-device',
        'joining-identity',
        'new-device',
      ]);
      await expect(
        replayChain(s.anchor, [...s.wires, wire], ownerManagedTeamPolicy)
      ).resolves.toMatchObject({ length: s.wires.length + 1 });
    }
    await s.act('B', invite, { device: 'child' });
    const next: ActionInput = { type: 'member.add', member: members.get('D')! };
    const stale = await s.sign('B', next, { device: 'child' });
    await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'member' });
    await expect(s.apply(stale)).rejects.toThrow('wrong-parent');
    for (const device of ['B-desktop', 'child'])
      await expect(s.act('B', next, { device })).rejects.toThrow('inviter-required');
    expect(s.snapshot.state.members.has('C')).toBe(true);
    expect(s.snapshot.state.members.has('D')).toBe(false);
    await s.act('B', { type: 'device.revoke', deviceId: 'B-desktop' }, { device: 'child' });
    expect(s.snapshot.state.members.get('B')!.devices.has('child')).toBe(true);
    await s.act('A', { type: 'member.remove', userId: 'B', instance: 'B1' });
    expect(listTeamRecipients(s.snapshot.state).some((r) => r.userId === 'B')).toBe(false);
    await expect(
      s.act('B', next, {
        device: 'child',
        instance: 'B1',
        slots: [
          { id: 'actor-device', publicKey: devices.get('child')!.signingKey },
          { id: 'joining-identity', publicKey: members.get('D')!.recoverySigningKey },
          { id: 'new-device', publicKey: members.get('D')!.device.signingKey },
        ],
      })
    ).rejects.toThrow('inactive-member-instance');
  });

  it('checks the role/action matrix with valid signatures, not signature booleans', async () => {
    const s = await team();
    for (const actor of ['A', 'B', 'C']) {
      const actions: [ActionInput, boolean][] = [
        [{ type: 'member.add', member: members.get('E')! }, actor !== 'C'],
        [{ type: 'member.remove', userId: 'D', instance: 'D1' }, actor === 'A'],
        [{ type: 'member.role', userId: 'D', instance: 'D1', role: 'admin' }, actor === 'A'],
        [{ type: 'device.add', device: devices.get('fresh')! }, true],
        [{ type: 'device.revoke', deviceId: `${actor}-desktop` }, true],
        [transfer('D'), actor === 'A'],
      ];
      for (const [action, allowed] of actions) {
        const wire = await s.sign(actor, action);
        const result = replayChain(s.anchor, [...s.wires, wire], ownerManagedTeamPolicy);
        if (allowed) await expect(result).resolves.toMatchObject({ length: s.wires.length + 1 });
        else await expect(result).rejects.toThrow();
      }
    }
  });

  it('requires joining identity, new-device possession and the approving device', async () => {
    const s = await scenario();
    const action: ActionInput = { type: 'member.add', member: members.get('B')! };
    const slots = expectedSlots(s.snapshot.state, 'A', 'A-desktop', action);
    for (const missing of slots) {
      await expect(
        s.apply(
          await s.sign('A', action, { slots: slots.filter((slot) => slot.id !== missing.id) })
        )
      ).rejects.toThrow('wrong-signers');
    }
    const forged = slots.map((slot) =>
      slot.id === 'joining-identity'
        ? { ...slot, publicKey: members.get('C')!.recoverySigningKey }
        : slot
    );
    await expect(s.apply(await s.sign('A', action, { slots: forged }))).rejects.toThrow(
      'bad-signature'
    );
    await s.admit('A', 'B');
    expect(s.snapshot.state.members.get('B')?.role).toBe('member');
  });

  it('retains an admitted C after removing inviter B, including only current recipients', async () => {
    const s = await scenario();
    await s.admit('A', 'B');
    await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'admin' });
    await s.admit('B', 'C');
    await s.act('B', {
      type: 'device.add',
      device: devices.get('machine')!,
    });
    await s.act('A', { type: 'member.remove', userId: 'B', instance: 'B1' });
    expect([...s.snapshot.state.members.keys()]).toEqual(['A', 'C']);
    const recipients = listTeamRecipients(s.snapshot.state);
    expect(recipients.filter((r) => r.userId === 'B')).toEqual([]);
    expect(
      recipients
        .filter((r) => r.userId === 'C')
        .map((r) => r.kind)
        .sort()
    ).toEqual(['device', 'recovery']);
    expect(s.snapshot.state.requiresKeyRotation).toBe(true);
  });

  it('re-admission needs a fresh instance and does not resurrect old devices or credentials', async () => {
    const s = await team();
    await s.act('B', {
      type: 'device.add',
      device: devices.get('child')!,
    });
    await s.act('A', { type: 'member.remove', userId: 'B', instance: 'B1' });
    await expect(s.admit('A', 'B')).rejects.toThrow('member-already-admitted');
    await s.act('A', { type: 'member.add', member: { ...members.get('B')!, instance: 'B2' } });
    expect([...s.snapshot.state.members.get('B')!.devices.keys()]).toEqual(['B-desktop']);
    const action: ActionInput = {
      type: 'device.add',
      device: devices.get('phone')!,
    };
    await expect(s.apply(await s.sign('B', action, { instance: 'B1' }))).rejects.toThrow(
      'inactive-member-instance'
    );
    await s.act('B', action);
    expect(
      listTeamRecipients(s.snapshot.state)
        .filter((r) => r.userId === 'B')
        .every((r) => r.instance === 'B2')
    ).toBe(true);
  });

  it('requires device possession to add or revoke; an identity root cannot replace it', async () => {
    const s = await scenario();
    const add: ActionInput = { type: 'device.add', device: devices.get('phone')! };
    const revoke: ActionInput = { type: 'device.revoke', deviceId: 'A-desktop' };
    for (const action of [add, revoke]) {
      const slots = expectedSlots(s.snapshot.state, 'A', 'A-desktop', action);
      for (const missing of slots)
        await expect(
          s.act('A', action, { slots: slots.filter((slot) => slot.id !== missing.id) })
        ).rejects.toThrow();
      await expect(
        s.act('A', action, {
          slots: slots.map((slot) =>
            slot.id === 'actor-device'
              ? { ...slot, publicKey: members.get('A')!.recoverySigningKey }
              : slot
          ),
        })
      ).rejects.toThrow('bad-signature');
    }
    await s.act('A', add);
    expect(s.snapshot.state.members.get('A')!.devices.has('phone')).toBe(true);
    await s.act('A', revoke, { device: 'phone' });
    expect([...s.snapshot.state.members.get('A')!.devices.keys()]).toEqual(['phone']);
  });

  it('cannot re-add revoked device IDs/keys or relabel an identity key as a device', async () => {
    const s = await scenario();
    await s.act('A', {
      type: 'device.add',
      device: devices.get('child')!,
    });
    await s.act('A', { type: 'device.revoke', deviceId: 'child' });
    await expect(
      s.act('A', {
        type: 'device.add',
        device: { ...devices.get('fresh')!, id: 'child' },
      })
    ).rejects.toThrow('device-id-reused');
    await expect(
      s.act('A', {
        type: 'device.add',
        device: { ...devices.get('child')!, id: 'new-id' },
      })
    ).rejects.toThrow('device-key-reused');
    await expect(
      s.act('A', {
        type: 'device.add',
        device: { ...devices.get('fresh')!, signingKey: members.get('A')!.recoverySigningKey },
      })
    ).rejects.toThrow('team-key-reused');
  });

  it('does not let an Owner Machine govern with its own valid signature', async () => {
    const s = await team();
    await s.act('A', {
      type: 'device.add',
      device: devices.get('machine')!,
    });
    await expect(
      s.act('A', { type: 'member.add', member: members.get('E')! }, { device: 'machine' })
    ).rejects.toThrow('inactive-personal-device');
    await expect(
      s.act('A', { type: 'device.add', device: devices.get('phone')! }, { device: 'machine' })
    ).rejects.toThrow('inactive-personal-device');
  });

  it('transfers exactly one Owner, retaining old Owner content access and rejecting stale config', async () => {
    const s = await team();
    const before = listTeamRecipients(s.snapshot.state);
    await s.act('A', transfer('B'));
    expect(s.snapshot.state.owner).toMatchObject({
      userId: 'B',
      instance: 'B1',
      configVersion: 1,
    });
    expect(s.snapshot.state.members.get('A')?.role).toBe('admin');
    expect([...s.snapshot.state.members.values()].filter((m) => m.role === 'owner')).toHaveLength(
      1
    );
    expect(listTeamRecipients(s.snapshot.state)).toEqual(before);
    expect(s.snapshot.state.requiresKeyRotation).toBe(false);
    await expect(
      s.act('B', { type: 'member.remove', userId: 'C', instance: 'C1', configVersion: 0 })
    ).rejects.toThrow('stale-owner-config');
    await expect(
      s.act('A', { type: 'member.remove', userId: 'C', instance: 'C1' })
    ).rejects.toThrow('owner-required');
    await s.act('B', transfer('A'));
    expect(s.snapshot.state.owner.configVersion).toBe(2);
    await expect(s.act('A', { ...transfer('B'), configVersion: 0 })).rejects.toThrow(
      'stale-owner-config'
    );
  });

  it('requires both current and accepting device signatures for transfer', async () => {
    const s = await team();
    const action = transfer('B');
    const slots = expectedSlots(s.snapshot.state, 'A', 'A-desktop', action);
    expect(slots.map((slot) => slot.id).sort()).toEqual(['accepting-device', 'actor-device']);
    for (const missing of slots)
      await expect(
        s.apply(
          await s.sign('A', action, { slots: slots.filter((slot) => slot.id !== missing.id) })
        )
      ).rejects.toThrow('wrong-signers');
    await s.act('A', transfer('B'));
    await s.act('B', transfer('A'));
    expect(s.snapshot.state.owner.userId).toBe('A');
  });

  it('rejects a competing transfer or a now-revoked accepting device', async () => {
    const s = await team();
    const toB = await s.sign('A', transfer('B'));
    const toC = await s.sign('A', transfer('C'));
    await s.apply(toB);
    await expect(s.apply(toC)).rejects.toThrow('wrong-parent');
    const t = await team();
    await t.act('B', { type: 'device.revoke', deviceId: 'B-desktop' });
    const slots = [
      { id: 'actor-device', publicKey: members.get('A')!.device.signingKey },
      { id: 'accepting-device', publicKey: members.get('B')!.device.signingKey },
    ];
    await expect(t.apply(await t.sign('A', transfer('B'), { slots }))).rejects.toThrow(
      'inactive-personal-device'
    );
  });

  it('rejects forged recovery actions, cross-user device mutation, and dangerous object-key IDs safely', async () => {
    const s = await team();
    await expect(s.act('A', { type: 'device.revoke', deviceId: 'B-desktop' })).rejects.toThrow(
      'inactive-device'
    );
    await expect(
      s.act('A', { type: 'member.remove', userId: 'A', instance: 'A1' })
    ).rejects.toThrow('cannot-remove-owner');
    const action = encodeTeamAction({
      type: 'member.remove',
      userId: 'B',
      instance: 'B1',
      configVersion: 0,
    });
    const decoded = new TextDecoder()
      .decode(fromHex(action.payload))
      .replace('member.remove', 'owner.recover');
    expect(() =>
      decodeTeamAction({
        kind: 'team-owner-recover',
        payload: toHex(new TextEncoder().encode(decoded)),
      })
    ).toThrow('unknown-team-action');
    await s.admit('A', 'constructor');
    expect(s.snapshot.state.members.get('constructor')?.role).toBe('member');
    const before = structuredClone(s.snapshot.state);
    const event: ControlEvent = {
      ...encodeTeamAction({
        type: 'member.role',
        userId: 'constructor',
        instance: 'constructor1',
        role: 'admin',
        configVersion: 0,
      }),
      actor: 'A',
      memberInstance: 'A1',
      device: 'A-desktop',
      genesis: s.anchor.genesis,
      previous: s.snapshot.head,
      operationId: 'ff'.repeat(16),
    };
    ownerManagedTeamPolicy.transition(s.snapshot.state, event);
    expect(s.snapshot.state).toEqual(before);
  });

  it.each(['A-desktop', 'phone'])(
    'keeps only %s when two own devices concurrently revoke each other',
    async (winner) => {
      const s = await scenario();
      await s.act('A', { type: 'device.add', device: devices.get('phone')! });
      const loser = winner === 'phone' ? 'A-desktop' : 'phone';
      const winAction: ActionInput = { type: 'device.revoke', deviceId: loser };
      const loseAction: ActionInput = { type: 'device.revoke', deviceId: winner };
      const winWire = await s.sign('A', winAction, { device: winner });
      const loseWire = await s.sign('A', loseAction, { device: loser });
      const stream = new MemoryStream();
      for (const wire of s.wires) stream.append(stream.tail, wire);
      const make = () =>
        new ControlLogClient(s.anchor, ownerManagedTeamPolicy, new MemoryStore(), stream);
      const first = make();
      const second = make();
      const entered = deferred();
      const release = deferred();
      stream.onAppend = async (offset, wire) => {
        if (wire === loseWire) {
          entered.resolve();
          await release.promise;
        }
        return stream.append(offset, wire);
      };
      const losing = second.submit(loseWire);
      await entered.promise;
      const won = await first.submit(winWire);
      expect(won.status).toBe('committed');
      release.resolve();
      expect((await losing).status).toBe('conflict');
      expect([...won.snapshot.state.members.get('A')!.devices.keys()]).toEqual([winner]);
      s.snapshot = won.snapshot;
      const rewritten = await s.sign('A', loseAction, {
        device: loser,
        slots: [{ id: 'actor-device', publicKey: devices.get(loser)!.signingKey }],
      });
      await expect(second.submit(rewritten)).rejects.toThrow('inactive-personal-device');
      expect((await second.read()).state).toEqual((await first.read()).state);
    }
  );

  it.each(['invite', 'remove'] as const)(
    'uses real Team policy when %s wins the same-head CAS race',
    async (winner) => {
      const s = await scenario();
      await s.admit('A', 'B');
      await s.act('A', { type: 'member.role', userId: 'B', instance: 'B1', role: 'admin' });
      const stream = new MemoryStream();
      for (const wire of s.wires) stream.append(stream.tail, wire);
      const owner = new ControlLogClient(
        s.anchor,
        ownerManagedTeamPolicy,
        new MemoryStore(),
        stream
      );
      const admin = new ControlLogClient(
        s.anchor,
        ownerManagedTeamPolicy,
        new MemoryStore(),
        stream
      );
      const invite = await s.sign('B', { type: 'member.add', member: members.get('C')! });
      const remove = await s.sign('A', { type: 'member.remove', userId: 'B', instance: 'B1' });
      const entered = deferred();
      const release = deferred();
      const loserWire = winner === 'invite' ? remove : invite;
      stream.onAppend = async (offset, wire) => {
        if (wire === loserWire) {
          entered.resolve();
          await release.promise;
        }
        return stream.append(offset, wire);
      };
      const losing = winner === 'invite' ? owner.submit(remove) : admin.submit(invite);
      await entered.promise;
      const winning = winner === 'invite' ? await admin.submit(invite) : await owner.submit(remove);
      expect(winning.status).toBe('committed');
      release.resolve();
      const conflict = await losing;
      expect(conflict.status).toBe('conflict');
      if (winner === 'invite') {
        s.wires.push(invite);
        s.snapshot = winning.snapshot;
        const removed = await owner.submit(
          await s.sign('A', { type: 'member.remove', userId: 'B', instance: 'B1' })
        );
        expect(removed.snapshot.state.members.has('C')).toBe(true);
        expect(removed.snapshot.state.members.has('B')).toBe(false);
      } else {
        const prior = s.snapshot;
        s.snapshot = { ...winning.snapshot, state: prior.state };
        const rewritten = await s.sign('B', { type: 'member.add', member: members.get('C')! });
        await expect(admin.submit(rewritten)).rejects.toThrow('inactive-member-instance');
        expect(conflict.snapshot.state.members.has('C')).toBe(false);
      }
      expect((await owner.read()).state).toEqual((await admin.read()).state);
    }
  );
});
