// Design model, not a product implementation test. Run with Node 22.14+:
// node --experimental-strip-types specs/models/session-files.model.ts
// Domain: two same-session submissions, at most one retry each, serialized events.
// Excludes persistence implementation, distributed writers, auth, filesystem and UI.
// Both entry points use this same draft-to-pending contract.

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type DraftAction = 'add' | 'remove' | 'replace' | 'navigate' | 'send';
type DraftDecision = 'keep-draft' | 'invalid' | 'saving' | 'owned';
function takeover(action: DraftAction, valid: boolean, saved: boolean): DraftDecision {
  if (action !== 'send') return 'keep-draft';
  if (!valid) return 'invalid';
  return saved ? 'owned' : 'saving';
}

let draftCases = 0;
for (const entry of ['new', 'continuation'] as const) {
  for (const action of ['add', 'remove', 'replace', 'navigate', 'send'] as const) {
    for (const valid of [false, true]) {
      for (const saved of [false, true]) {
        const decision = takeover(action, valid, saved);
        const canStartTransfer = decision === 'owned';
        const canClearDraft = decision === 'owned';
        assert(!canStartTransfer || action === 'send', `${entry} A01: no transfer before Send`);
        assert(!canClearDraft || (valid && saved), `${entry} A17: preserve unowned draft`);
        if (action !== 'send') assert(decision === 'keep-draft', `${entry} A10: draft-only action`);
        if (action === 'send' && valid && saved)
          assert(canStartTransfer, `${entry} A09: send works`);
        draftCases++;
      }
    }
  }
}

const phases = ['pending', 'uploading', 'verifying', 'ready', 'failed'] as const;
let readinessCases = 0;
for (const first of phases) {
  for (const second of phases) {
    const ready = [first, second].every((phase) => phase === 'ready');
    assert(!ready || (first === 'ready' && second === 'ready'), 'A03: all attachments required');
    // Counterexample to retaining the old failed-file filtering rule.
    if (first === 'ready' && second === 'failed') {
      const oldPhases: string[] = [first, second];
      const oldAllowsSend = !oldPhases.some((phase) => phase === 'uploading');
      assert(oldAllowsSend && !ready, 'Old filtering must differ on partial failure');
    }
    readinessCases++;
  }
}

type Phase =
  | 'preparing'
  | 'ready'
  | 'failed'
  | 'submitting'
  | 'uncertain'
  | 'handed-off'
  | 'canceled';
type Slot = { phase: Phase; generation: 0 | 1; accepted: boolean };
type State = [Slot, Slot];
type ModelEvent =
  | 'prepared'
  | 'failed'
  | 'retry'
  | 'cancel'
  | 'submit'
  | 'ack'
  | 'timeout'
  | 'persist';
const events: ModelEvent[] = [
  'prepared',
  'failed',
  'retry',
  'cancel',
  'submit',
  'ack',
  'timeout',
  'persist',
];
const finished = (slot: Slot) => slot.phase === 'handed-off' || slot.phase === 'canceled';

function transition(state: State, index: 0 | 1, event: ModelEvent, generation: 0 | 1): State {
  const next: State = [{ ...state[0] }, { ...state[1] }];
  const slot = next[index];
  if (finished(slot)) return next;
  if (event === 'prepared' || event === 'failed') {
    if (slot.phase === 'preparing' && slot.generation === generation) {
      slot.phase = event === 'prepared' ? 'ready' : 'failed';
    }
  } else if (event === 'retry' && slot.phase === 'failed' && slot.generation === 0) {
    slot.generation = 1;
    slot.phase = 'preparing';
  } else if (event === 'cancel' && ['preparing', 'ready', 'failed'].includes(slot.phase)) {
    slot.phase = 'canceled';
  } else if (event === 'submit' && slot.phase === 'ready' && (index === 0 || finished(next[0]))) {
    slot.phase = 'submitting';
  } else if (event === 'ack' && ['submitting', 'uncertain'].includes(slot.phase)) {
    slot.accepted = true;
  } else if (event === 'timeout' && slot.phase === 'submitting') {
    slot.phase = 'uncertain';
  } else if (event === 'persist' && slot.accepted) {
    // Abstract evidence that input AND dispatch/queue handoff are durable.
    slot.phase = 'handed-off';
  }
  return next;
}

const initial: State = [
  { phase: 'preparing', generation: 0, accepted: false },
  { phase: 'preparing', generation: 0, accepted: false },
];
const frontier: State[] = [initial];
const seen = new Set([JSON.stringify(initial)]);
let checkedTransitions = 0;
for (let cursor = 0; cursor < frontier.length; cursor++) {
  const before = frontier[cursor]!;
  for (const index of [0, 1] as const) {
    for (const event of events) {
      for (const generation of [0, 1] as const) {
        const after = transition(before, index, event, generation);
        const old = before[index];
        const current = after[index];
        if (finished(old)) assert(JSON.stringify(current) === JSON.stringify(old), 'A04: terminal');
        if (current.phase === 'submitting' && old.phase !== 'submitting') {
          assert(old.phase === 'ready', 'A03: preparation before submit');
          assert(index === 0 || finished(before[0]), 'A05: no overtaking');
        }
        if (event === 'ack' && old.phase !== 'handed-off') {
          assert(current.phase !== 'handed-off', 'A14: ACK is not durability');
        }
        if (old.phase === 'submitting' || old.phase === 'uncertain') {
          assert(current.phase !== 'canceled', 'Cancellation cannot recall submitted work');
        }
        if ((event === 'prepared' || event === 'failed') && generation !== old.generation) {
          assert(JSON.stringify(old) === JSON.stringify(current), 'A04: obsolete callback');
        }
        if (current.phase === 'handed-off' && old.phase !== 'handed-off') {
          assert(event === 'persist' && old.accepted, 'A14: require safe handoff evidence');
        }
        const key = JSON.stringify(after);
        if (!seen.has(key)) {
          seen.add(key);
          frontier.push(after);
        }
        checkedTransitions++;
      }
    }
  }
}
assert(
  frontier.some((state) => state.every((slot) => slot.phase === 'handed-off')),
  'Both can complete'
);
assert(
  frontier.some((state) => state[0].phase === 'canceled' && state[1].phase === 'handed-off'),
  'Cancel unblocks'
);
console.log(
  JSON.stringify({ draftCases, readinessCases, reachableStates: seen.size, checkedTransitions })
);
