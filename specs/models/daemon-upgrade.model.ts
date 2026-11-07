// node specs/models/daemon-upgrade.model.ts
// Finite design abstraction; not crypto, filesystem, process or native acceptance.
import assert from 'node:assert/strict';

type Phase =
  | 'legacy'
  | 'migrating'
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'stopping'
  | 'probing'
  | 'applied'
  | 'rollback-stop'
  | 'rollback-start'
  | 'rolled-back'
  | 'recovering'
  | 'blocked'
  | 'failed';
type State = {
  phase: Phase;
  root: 'absent' | 'alive' | 'crashed';
  lease: 'legacy' | 'root' | 'foreign' | 'none';
  oldTree: boolean;
  newTree: boolean;
  verified: boolean;
  durable: boolean;
  selected: 'old' | 'new';
  confirmed: boolean;
  activeTurn: boolean;
};
const initial: State = {
  phase: 'legacy',
  root: 'absent',
  lease: 'legacy',
  oldTree: true,
  newTree: false,
  verified: false,
  durable: false,
  selected: 'old',
  confirmed: false,
  activeTurn: false,
};
const events = [
  'legacy-direct-sea',
  'explicit-installer',
  'legacy-tree-stopped',
  'install-root',
  'request',
  'prepared-and-synced',
  'prepare-failed',
  'idle-authorized',
  'busy',
  'old-tree-stopped',
  'termination-unknown',
  'candidate-started',
  'candidate-failed',
  'candidate-healthy-and-synced',
  'candidate-tree-stopped',
  'old-started-healthy',
  'rollback-failed',
  'root-crashed',
  'foreign-acquired',
  'foreign-released',
  'root-restarted',
  'owned-trees-stopped',
  'resume-selected',
  'network-lost',
  'duplicate-request',
  'observe-result',
  'turn-started',
  'turn-finished',
  'immediate-authorized',
  'authority-revoked',
] as const;
type Event = (typeof events)[number];

function step(s: State, event: Event): State {
  if (['legacy-direct-sea', 'busy', 'network-lost', 'duplicate-request'].includes(event)) return s;
  if (event === 'turn-started' && ['idle', 'preparing', 'waiting'].includes(s.phase))
    return { ...s, activeTurn: true };
  if (event === 'turn-finished') return { ...s, activeTurn: false };
  if (event === 'authority-revoked' && ['preparing', 'waiting'].includes(s.phase))
    return { ...s, phase: 'failed' };
  if (event === 'observe-result')
    return s.phase === 'applied' && s.root === 'alive' && s.lease === 'root'
      ? { ...s, confirmed: true }
      : s;
  if (event === 'root-crashed' && s.root === 'alive') {
    // Crash releases the root lease; it proves nothing about descendants.
    return { ...s, root: 'crashed', lease: 'none', phase: 'recovering', confirmed: false };
  }
  if (event === 'foreign-acquired' && s.lease === 'none') return { ...s, lease: 'foreign' };
  if (event === 'foreign-released' && s.lease === 'foreign') return { ...s, lease: 'none' };
  if (s.phase === 'legacy' && event === 'explicit-installer') return { ...s, phase: 'migrating' };
  if (s.phase === 'migrating') {
    if (event === 'legacy-tree-stopped') return { ...s, oldTree: false, lease: 'none' };
    if (event === 'install-root' && !s.oldTree && s.lease === 'none') {
      return { ...s, root: 'alive', lease: 'root', phase: 'idle', durable: true, oldTree: true };
    }
    return s;
  }
  if (s.phase === 'recovering' || s.phase === 'blocked') {
    if (event === 'root-restarted') {
      if (s.lease === 'foreign') return { ...s, phase: 'blocked' };
      if (s.lease === 'none') return { ...s, root: 'alive', lease: 'root', phase: 'recovering' };
    }
    if (s.root !== 'alive' || s.lease !== 'root') return s;
    if (event === 'owned-trees-stopped') return { ...s, oldTree: false, newTree: false };
    if (event === 'termination-unknown') return { ...s, phase: 'blocked' };
    if (event === 'resume-selected' && !s.oldTree && !s.newTree) {
      // Durable selection and verified immutable files guide recovery, not PID luck.
      return s.selected === 'old'
        ? { ...s, oldTree: true, phase: 'rolled-back' }
        : { ...s, newTree: true, phase: 'probing' };
    }
    return s;
  }
  if (s.root !== 'alive' || s.lease !== 'root') return s;
  if (s.phase === 'idle' && event === 'request') return { ...s, phase: 'preparing' };
  if (s.phase === 'preparing') {
    if (event === 'prepared-and-synced')
      return { ...s, phase: 'waiting', verified: true, durable: true };
    if (event === 'prepare-failed') return { ...s, phase: 'failed' };
  }
  if (
    s.phase === 'waiting' &&
    ((event === 'idle-authorized' && !s.activeTurn) || event === 'immediate-authorized') &&
    s.durable
  )
    return { ...s, phase: 'stopping' };
  if (s.phase === 'stopping') {
    if (event === 'termination-unknown') return { ...s, phase: 'blocked' };
    if (event === 'old-tree-stopped') return { ...s, oldTree: false, activeTurn: false };
    if (event === 'candidate-started' && !s.oldTree && s.verified)
      return { ...s, newTree: true, phase: 'probing' };
  }
  if (s.phase === 'probing') {
    if (event === 'candidate-healthy-and-synced')
      return { ...s, phase: 'applied', selected: 'new' };
    if (event === 'candidate-failed') return { ...s, phase: 'rollback-stop', confirmed: false };
  }
  if (s.phase === 'rollback-stop') {
    if (event === 'candidate-tree-stopped')
      return { ...s, phase: 'rollback-start', newTree: false };
    if (event === 'termination-unknown') return { ...s, phase: 'blocked' };
  }
  if (s.phase === 'rollback-start') {
    if (event === 'old-started-healthy' && !s.newTree)
      return { ...s, phase: 'rolled-back', oldTree: true };
    if (event === 'rollback-failed') return { ...s, phase: 'blocked' };
  }
  return s;
}
function check(s: State) {
  assert(!(s.oldTree && s.newTree), 'never overlap owned writers');
  assert(!s.newTree || s.verified, 'candidate must be verified');
  assert(
    !s.confirmed || (s.phase === 'applied' && s.newTree && s.lease === 'root'),
    'no false success'
  );
  assert(
    s.phase !== 'rolled-back' || (s.oldTree && s.lease === 'root'),
    'foreign ownership is not recovery'
  );
  assert(
    s.phase !== 'applied' || (s.selected === 'new' && s.newTree && s.durable),
    'commit must be durable'
  );
}
const seen = new Set([JSON.stringify(initial)]),
  queue = [initial];
let transitions = 0;
for (let i = 0; i < queue.length; i++) {
  const before = queue[i];
  check(before);
  for (const event of events) {
    const after = step(before, event);
    check(after);
    if (before.root === 'alive' && !['root-crashed', 'root-restarted'].includes(event)) {
      assert.equal(after.lease, before.lease, 'ordinary update retains the root lease');
    }
    if (before.phase === 'waiting' && before.activeTurn && event === 'idle-authorized')
      assert.equal(after.phase, 'waiting');
    if (before.oldTree && after.newTree) assert.fail('replacement needs old tree stop proof');
    const key = JSON.stringify(after);
    if (!seen.has(key)) {
      seen.add(key);
      queue.push(after);
    }
    transitions++;
  }
}
const migrated: Event[] = ['explicit-installer', 'legacy-tree-stopped', 'install-root'];
const prepared: Event[] = [...migrated, 'request', 'prepared-and-synced', 'idle-authorized'];
const candidate: Event[] = [...prepared, 'old-tree-stopped', 'candidate-started'];
const trace = (...es: Event[]) => es.reduce(step, initial);
assert.equal(trace('legacy-direct-sea').phase, 'legacy');
assert.equal(trace(...candidate, 'candidate-healthy-and-synced', 'observe-result').confirmed, true);
assert.equal(
  trace(...candidate, 'candidate-failed', 'candidate-tree-stopped', 'old-started-healthy').phase,
  'rolled-back'
);
assert.equal(
  trace(...candidate, 'root-crashed', 'foreign-acquired', 'root-restarted').phase,
  'blocked'
);
assert.equal(
  trace(...candidate, 'root-crashed', 'root-restarted', 'resume-selected').phase,
  'recovering'
);
assert.equal(
  trace(...candidate, 'root-crashed', 'root-restarted', 'owned-trees-stopped', 'resume-selected')
    .phase,
  'rolled-back'
);
assert.equal(
  trace(...migrated, 'request', 'prepared-and-synced', 'turn-started', 'idle-authorized').phase,
  'waiting'
);
assert.equal(
  trace(
    ...migrated,
    'request',
    'prepared-and-synced',
    'turn-started',
    'immediate-authorized',
    'termination-unknown'
  ).phase,
  'blocked'
);
// Negative controls: make unsafe designs fail the same invariants.
assert.throws(() => check({ ...trace(...candidate), oldTree: true }));
assert.throws(() => check({ ...trace(...candidate), confirmed: true }));
assert.throws(() => check({ ...trace(...migrated), phase: 'rolled-back', lease: 'foreign' }));
console.log(
  JSON.stringify({ states: seen.size, transitions, positivePaths: 8, negativeControls: 3 })
);
