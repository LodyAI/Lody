/**
 * Finite authorization oracle for the ledger `step`, mirroring proofs/e2ee/E2EE.lean.
 * Management is role-derived: an active personal device of a current Owner/Admin
 * manages; machine and recovery devices never do. There is no per-device flag.
 * Not a reimplementation of Ledger; correspondence tests drive the public API.
 * Owner transfer matches proofs/e2ee/E2EE.lean (D1 A). setRoleGuest matches D5.
 */
export type Kind = 'personal' | 'machine' | 'recovery';
export type LeanRole = 'owner' | 'admin' | 'member' | 'guest';
export type LeanDevice = { memberId: number; kind: Kind };
export type LeanState = {
  owner: number;
  members: Array<[number, LeanRole]>;
  devices: Array<[number, LeanDevice]>;
  epoch: number;
  retired: number[];
  usedMembers: number[];
};
export type LeanOp =
  | { type: 'admitMember'; actor: number; newMember: number; firstDevice: number }
  | { type: 'removeMember'; actor: number; target: number }
  | { type: 'setRoleAdmin'; actor: number; target: number }
  | { type: 'setRoleMember'; actor: number; target: number }
  | { type: 'setRoleGuest'; actor: number; target: number }
  | { type: 'admitDevice'; actor: number; newId: number; kind: Kind }
  | { type: 'revokeDevice'; actor: number; target: number }
  | { type: 'publishEpoch'; actor: number }
  | { type: 'transferOwner'; actor: number; successor: number };

export function roleOf(s: LeanState, memberId: number): LeanRole | undefined {
  return s.members.find((row) => row[0] === memberId)?.[1];
}
export function deviceOf(s: LeanState, id: number): LeanDevice | undefined {
  return s.devices.find((row) => row[0] === id)?.[1];
}
export function isPersonalManage(s: LeanState, actor: number): boolean {
  const d = deviceOf(s, actor);
  if (!d || d.kind !== 'personal') return false;
  const role = roleOf(s, d.memberId);
  return role === 'owner' || role === 'admin';
}
export function isOwnerManage(s: LeanState, actor: number): boolean {
  const d = deviceOf(s, actor);
  if (!d || d.kind !== 'personal') return false;
  return roleOf(s, d.memberId) === 'owner';
}

export function leanStep(s: LeanState, op: LeanOp): LeanState | null {
  switch (op.type) {
    case 'admitMember': {
      if (!isPersonalManage(s, op.actor)) return null;
      if (s.usedMembers.includes(op.newMember)) return null;
      if (roleOf(s, op.newMember) !== undefined) return null;
      if (deviceOf(s, op.firstDevice) !== undefined) return null;
      if (s.retired.includes(op.firstDevice)) return null;
      return {
        ...s,
        members: [...s.members, [op.newMember, 'member']],
        devices: [...s.devices, [op.firstDevice, { memberId: op.newMember, kind: 'personal' }]],
        usedMembers: [...s.usedMembers, op.newMember],
      };
    }
    case 'removeMember': {
      if (!isOwnerManage(s, op.actor)) return null;
      if (op.target === s.owner) return null;
      if (roleOf(s, op.target) === undefined) return null;
      const dropped = s.devices.filter((row) => row[1].memberId === op.target).map((row) => row[0]);
      return {
        ...s,
        members: s.members.filter((row) => row[0] !== op.target),
        devices: s.devices.filter((row) => row[1].memberId !== op.target),
        retired: [...s.retired, ...dropped],
      };
    }
    case 'setRoleAdmin':
    case 'setRoleMember':
    case 'setRoleGuest': {
      if (!isOwnerManage(s, op.actor)) return null;
      if (op.target === s.owner) return null;
      if (roleOf(s, op.target) === undefined) return null;
      const next: LeanRole =
        op.type === 'setRoleAdmin' ? 'admin' : op.type === 'setRoleMember' ? 'member' : 'guest';
      return {
        ...s,
        members: s.members.map((row) => (row[0] === op.target ? [row[0], next] : row)),
      };
    }
    case 'admitDevice': {
      const d = deviceOf(s, op.actor);
      if (!d) return null;
      const ok =
        (d.kind === 'personal' || d.kind === 'recovery') &&
        (d.kind !== 'recovery' || op.kind === 'personal') &&
        (roleOf(s, d.memberId) !== 'guest' || op.kind !== 'machine') &&
        deviceOf(s, op.newId) === undefined &&
        !s.retired.includes(op.newId);
      if (!ok) return null;
      return {
        ...s,
        devices: [...s.devices, [op.newId, { memberId: d.memberId, kind: op.kind }]],
      };
    }
    case 'revokeDevice': {
      const a = deviceOf(s, op.actor);
      const t = deviceOf(s, op.target);
      if (!a || !t || a.kind !== 'personal' || a.memberId !== t.memberId) return null;
      return {
        ...s,
        devices: s.devices.filter((row) => row[0] !== op.target),
        retired: [...s.retired, op.target],
      };
    }
    case 'publishEpoch': {
      if (!isPersonalManage(s, op.actor)) return null;
      return { ...s, epoch: s.epoch + 1 };
    }
    case 'transferOwner': {
      if (!isOwnerManage(s, op.actor)) return null;
      if (op.successor === s.owner) return null;
      if (roleOf(s, op.successor) === undefined) return null;
      return {
        ...s,
        owner: op.successor,
        members: s.members.map((row) =>
          row[0] === s.owner ? [row[0], 'admin'] : row[0] === op.successor ? [row[0], 'owner'] : row
        ),
      };
    }
  }
  return null;
}

export const genesis: LeanState = {
  owner: 0,
  members: [[0, 'owner']],
  devices: [[0, { memberId: 0, kind: 'personal' }]],
  epoch: 0,
  retired: [],
  usedMembers: [0],
};

export function stateKey(s: LeanState): string {
  const members = [...s.members].sort((a, b) => a[0] - b[0]);
  const devices = [...s.devices].sort((a, b) => a[0] - b[0]);
  const retired = [...s.retired].sort((a, b) => a - b);
  const usedMembers = [...s.usedMembers].sort((a, b) => a - b);
  return JSON.stringify({
    owner: s.owner,
    members,
    devices,
    epoch: s.epoch,
    retired,
    usedMembers,
  });
}

export function assertAuthInvariants(s: LeanState): void {
  const owners = s.members.filter((row) => row[1] === 'owner');
  if (owners.length !== 1 || owners[0]![0] !== s.owner) {
    throw new Error('owner-invariant');
  }
  if (roleOf(s, s.owner) !== 'owner') throw new Error('owner-missing');
  for (const [id, device] of s.devices) {
    if (s.retired.includes(id)) throw new Error('retired-still-active');
    if (roleOf(s, device.memberId) === undefined) throw new Error('orphan-device');
  }
}

export function candidateOps(maxMember: number, maxDevice: number, maxEpoch: number): LeanOp[] {
  const ops: LeanOp[] = [];
  const members = Array.from({ length: maxMember + 1 }, (_, i) => i);
  const devices = Array.from({ length: maxDevice + 1 }, (_, i) => i);
  const kinds: Kind[] = ['personal', 'machine', 'recovery'];
  for (const actor of devices) {
    ops.push({ type: 'publishEpoch', actor });
    for (const target of members) {
      ops.push({ type: 'removeMember', actor, target });
      ops.push({ type: 'setRoleAdmin', actor, target });
      ops.push({ type: 'setRoleMember', actor, target });
      ops.push({ type: 'setRoleGuest', actor, target });
      ops.push({ type: 'transferOwner', actor, successor: target });
    }
    for (const target of devices) {
      ops.push({ type: 'revokeDevice', actor, target });
    }
    for (const newMember of members) {
      for (const firstDevice of devices) {
        ops.push({ type: 'admitMember', actor, newMember, firstDevice });
      }
    }
    for (const newId of devices) {
      for (const kind of kinds) {
        ops.push({ type: 'admitDevice', actor, newId, kind });
      }
    }
  }
  void maxEpoch;
  return ops;
}

export function explore(bounds: {
  maxMember: number;
  maxDevice: number;
  maxEpoch: number;
  maxDepth: number;
}): {
  states: number;
  maxDepthReached: number;
  enabled: number;
  rejected: number;
  recoveryStates: number;
  retiredStates: number;
  outOfBound: string[];
} {
  const ops = candidateOps(bounds.maxMember, bounds.maxDevice, bounds.maxEpoch);
  const seen = new Set<string>([stateKey(genesis)]);
  const queue: Array<{ state: LeanState; depth: number }> = [{ state: genesis, depth: 0 }];
  let enabled = 0;
  let rejected = 0;
  let maxDepthReached = 0;
  let recoveryStates = 0;
  let retiredStates = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    maxDepthReached = Math.max(maxDepthReached, item.depth);
    assertAuthInvariants(item.state);
    if (item.state.devices.some((row) => row[1].kind === 'recovery')) recoveryStates += 1;
    if (item.state.retired.length > 0) retiredStates += 1;
    if (item.depth >= bounds.maxDepth) continue;
    for (const op of ops) {
      if (op.type === 'publishEpoch' && item.state.epoch >= bounds.maxEpoch) {
        rejected += 1;
        continue;
      }
      const next = leanStep(item.state, op);
      if (!next) {
        rejected += 1;
        continue;
      }
      enabled += 1;
      const key = stateKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ state: next, depth: item.depth + 1 });
    }
  }
  return {
    states: seen.size,
    maxDepthReached,
    enabled,
    rejected,
    recoveryStates,
    retiredStates,
    outOfBound: [
      'R2 Passkey wrap not in authorization or submit/delivery step',
      'cross-Org not in single-Org step',
    ],
  };
}

/** L5 submit/CAS environment (not Lean `step`). Exact pending bytes; no re-sign. */
export type SubmitPhase = 'idle' | 'pending' | 'committed' | 'conflict' | 'unsupported';
export type SubmitState = {
  phase: SubmitPhase;
  candidate: 'none' | 'A' | 'B';
  remote: 'empty' | 'A' | 'B';
  lostAck: boolean;
  falseAck: boolean;
};

export type SubmitEvent =
  | { type: 'prepare'; candidate: 'A' | 'B' }
  | { type: 'cas' }
  | { type: 'loseAck' }
  | { type: 'falseAck' }
  | { type: 'readBack' }
  | { type: 'resume' }
  | { type: 'unsupported' };

export function submitStep(s: SubmitState, ev: SubmitEvent): SubmitState | null {
  switch (ev.type) {
    case 'prepare':
      if (s.phase !== 'idle' && s.phase !== 'conflict') return null;
      return { ...s, phase: 'pending', candidate: ev.candidate, lostAck: false, falseAck: false };
    case 'cas': {
      if (s.phase !== 'pending' || s.candidate === 'none') return null;
      if (s.remote === 'empty' || s.remote === s.candidate) {
        return {
          phase: 'committed',
          candidate: s.candidate,
          remote: s.candidate,
          lostAck: false,
          falseAck: false,
        };
      }
      return { ...s, phase: 'conflict', lostAck: false, falseAck: false };
    }
    case 'loseAck':
      if (s.phase !== 'pending' || s.candidate === 'none') return null;
      if (s.remote !== 'empty' && s.remote !== s.candidate) return null;
      return {
        phase: 'pending',
        candidate: s.candidate,
        remote: s.candidate,
        lostAck: true,
        falseAck: false,
      };
    case 'falseAck':
      if (s.phase !== 'pending' || s.candidate === 'none') return null;
      return { ...s, lostAck: false, falseAck: true };
    case 'readBack':
      if (!s.lostAck && !s.falseAck) return null;
      if (s.candidate !== 'none' && s.remote === s.candidate) {
        return {
          phase: 'committed',
          candidate: s.candidate,
          remote: s.remote,
          lostAck: false,
          falseAck: false,
        };
      }
      return { ...s, falseAck: false };
    case 'resume':
      if (s.phase !== 'pending' || s.candidate === 'none') return null;
      if (s.falseAck) return { ...s };
      if (s.remote === 'empty' || s.remote === s.candidate) {
        return {
          phase: 'committed',
          candidate: s.candidate,
          remote: s.candidate,
          lostAck: false,
          falseAck: false,
        };
      }
      return { ...s, phase: 'conflict' };
    case 'unsupported':
      if (s.phase !== 'pending') return null;
      return {
        phase: 'unsupported',
        candidate: 'none',
        remote: s.remote,
        lostAck: false,
        falseAck: false,
      };
  }
  return null;
}

function submitKey(s: SubmitState): string {
  return `${s.phase}|${s.candidate}|${s.remote}|${s.lostAck ? 1 : 0}|${s.falseAck ? 1 : 0}`;
}

export function exploreSubmit(): { states: number; enabled: number; rejected: number } {
  const start: SubmitState = {
    phase: 'idle',
    candidate: 'none',
    remote: 'empty',
    lostAck: false,
    falseAck: false,
  };
  const events: SubmitEvent[] = [
    { type: 'prepare', candidate: 'A' },
    { type: 'prepare', candidate: 'B' },
    { type: 'cas' },
    { type: 'loseAck' },
    { type: 'falseAck' },
    { type: 'readBack' },
    { type: 'resume' },
    { type: 'unsupported' },
  ];
  const seen = new Set<string>([submitKey(start)]);
  const queue = [start];
  let enabled = 0;
  let rejected = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const ev of events) {
      const next = submitStep(cur, ev);
      if (!next) {
        rejected += 1;
        continue;
      }
      enabled += 1;
      const key = submitKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return { states: seen.size, enabled, rejected };
}

/** K3 key-delivery environment (not Lean `step`). Persist exact ciphertext before PUT. */
export type DeliveryState = {
  recipient: 'active' | 'revoked';
  outbox: 'empty' | 'frame';
  remote: 'empty' | 'frame';
  phase: 'idle' | 'authorizing' | 'persisted';
};

export type DeliveryEvent =
  | { type: 'startAuthorize' }
  | { type: 'revoke' }
  | { type: 'persist' }
  | { type: 'put' }
  | { type: 'loseAck' }
  | { type: 'resume' };

export function deliveryStep(s: DeliveryState, ev: DeliveryEvent): DeliveryState | null {
  switch (ev.type) {
    case 'startAuthorize':
      if (s.phase !== 'idle' || s.recipient !== 'active') return null;
      return { ...s, phase: 'authorizing' };
    case 'revoke':
      return {
        ...s,
        recipient: 'revoked',
        phase: s.phase === 'authorizing' ? 'idle' : s.phase,
        outbox: s.phase === 'authorizing' ? 'empty' : s.outbox,
      };
    case 'persist':
      if (s.phase !== 'authorizing' || s.recipient !== 'active') return null;
      return { ...s, phase: 'persisted', outbox: 'frame' };
    case 'put':
      if (s.phase !== 'persisted' || s.outbox !== 'frame' || s.recipient !== 'active') return null;
      return { ...s, remote: 'frame' };
    case 'loseAck':
      if (s.remote !== 'frame' || s.outbox !== 'frame') return null;
      return { ...s };
    case 'resume':
      if (s.outbox !== 'frame') return null;
      if (s.recipient !== 'active') return null;
      return { ...s, remote: 'frame' };
  }
  return null;
}

function deliveryKey(s: DeliveryState): string {
  return `${s.recipient}|${s.outbox}|${s.remote}|${s.phase}`;
}

export function exploreDelivery(): { states: number; enabled: number; rejected: number } {
  const start: DeliveryState = {
    recipient: 'active',
    outbox: 'empty',
    remote: 'empty',
    phase: 'idle',
  };
  const events: DeliveryEvent[] = [
    { type: 'startAuthorize' },
    { type: 'revoke' },
    { type: 'persist' },
    { type: 'put' },
    { type: 'loseAck' },
    { type: 'resume' },
  ];
  const seen = new Set<string>([deliveryKey(start)]);
  const queue = [start];
  let enabled = 0;
  let rejected = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const ev of events) {
      const next = deliveryStep(cur, ev);
      if (!next) {
        rejected += 1;
        continue;
      }
      enabled += 1;
      const key = deliveryKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return { states: seen.size, enabled, rejected };
}
