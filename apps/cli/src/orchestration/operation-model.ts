/** Reduced current Inbox contract. SQLite and execution suites verify the real boundaries. */
export type InboxModel = {
  next: number;
  queue: number[];
  consumed: number[];
  pending: number[];
  paused: boolean;
  human: boolean;
  automation: boolean;
  active: 'none' | 'human' | 'automatic' | 'automation';
  batch: number[];
  submitted: boolean;
  receipts: number[][];
  boundary: number[] | undefined;
};
export type InboxEvent =
  | 'result'
  | 'human'
  | 'automation'
  | 'schedule'
  | 'submit'
  | 'normal'
  | 'stop'
  | 'failed'
  | 'restart'
  | 'withdraw'
  | 'duplicate_release';
export const initialOrchestrationModelState = (): InboxModel => ({
  next: 1,
  queue: [],
  consumed: [],
  pending: [],
  paused: false,
  human: false,
  automation: false,
  active: 'none',
  batch: [],
  submitted: false,
  receipts: [],
  boundary: undefined,
});
export function stepOrchestrationModel(before: InboxModel, event: InboxEvent): InboxModel {
  const s = structuredClone(before);
  const consume = () => {
    if (s.submitted) {
      s.consumed.push(...s.batch);
      s.queue = s.queue.filter((n) => !s.batch.includes(n));
    }
  };
  const release = () => {
    s.active = 'none';
    s.batch = [];
    s.submitted = false;
  };
  switch (event) {
    case 'result':
      if (s.next <= 3) {
        s.queue.push(s.next++);
        if (s.active === 'none' && !s.paused && !s.human) s.pending = [...s.queue];
      }
      break;
    case 'human':
      s.human = true;
      s.paused = false;
      s.pending = [];
      break;
    case 'automation':
      if (!s.paused) s.automation = true;
      break;
    case 'schedule':
      if (s.active !== 'none' || s.paused) break;
      if (s.human) {
        s.active = 'human';
        s.human = false;
        s.batch = [...s.queue];
        s.pending = [];
        s.boundary = undefined;
      } else if (s.automation) {
        s.active = 'automation';
        s.automation = false;
        s.batch = [...s.queue];
        s.pending = [];
        s.boundary = undefined;
      } else if (s.pending.length) {
        s.active = 'automatic';
        s.batch = [...s.queue];
        s.pending = [];
        s.boundary = undefined;
        if (!s.batch.length) release();
      }
      break;
    case 'submit':
      if (s.active === 'none' || s.submitted || s.paused) break;
      if ((s.active === 'automatic' || s.active === 'automation') && s.human) break;
      if (s.active === 'automatic' && !s.batch.length) break;
      if (s.batch.length) s.receipts.push([...s.batch]);
      s.submitted = true;
      break;
    case 'normal':
      if (s.active === 'none' || !s.submitted) break;
      consume();
      s.boundary = [...s.queue];
      s.pending = s.paused || s.human ? [] : [...s.queue];
      release();
      break;
    case 'stop':
      s.paused = true;
      s.human = false;
      s.automation = false;
      s.pending = [];
      consume();
      release();
      break;
    case 'failed':
      if (s.active === 'none') break;
      consume();
      s.pending = [];
      release();
      break;
    case 'restart':
      // The interrupted execution retires as unknown: never replayed, never blocking.
      if (s.active !== 'none') {
        consume();
        s.pending = [];
        release();
      }
      break;
    case 'withdraw':
      // An unverified human execution returns its input before submission.
      if (s.active !== 'human' || s.submitted) break;
      s.active = 'none';
      s.batch = [];
      s.human = true;
      break;
    case 'duplicate_release':
      break; // duplicate release cannot create another intent
  }
  assertOrchestrationModelSafety(s);
  return s;
}
export function assertOrchestrationModelSafety(s: InboxModel) {
  const delivered = s.receipts.flat();
  if (new Set(delivered).size !== delivered.length) throw new Error('Result submitted twice');
  if (s.receipts.some((batch) => batch.length === 0)) throw new Error('Empty automatic batch');
  if (s.paused && s.pending.length) throw new Error('Paused session has automatic intent');
  if (s.pending.some((n) => !s.queue.includes(n)))
    throw new Error('Intent does not own queued data');
}
export function enumerateOrchestrationModel(depth = 8) {
  const actions: InboxEvent[] = [
    'result',
    'human',
    'automation',
    'schedule',
    'submit',
    'normal',
    'stop',
    'failed',
    'restart',
    'withdraw',
    'duplicate_release',
  ];
  const initial = initialOrchestrationModelState();
  const states = new Map([[JSON.stringify(initial), initial]]);
  let frontier = [initial];
  for (let d = 0; d < depth; d++) {
    const next: InboxModel[] = [];
    for (const state of frontier)
      for (const event of actions) {
        const s = stepOrchestrationModel(state, event),
          key = JSON.stringify(s);
        if (!states.has(key)) {
          states.set(key, s);
          next.push(s);
        }
      }
    frontier = next;
  }
  return [...states.values()];
}
