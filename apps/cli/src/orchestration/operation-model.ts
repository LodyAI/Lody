/** Reduced current Inbox contract. SQLite and execution suites verify the real boundaries. */
export type InboxModel = {
  next: number;
  queue: number[];
  consumed: number[];
  pending: number[];
  paused: boolean;
  blocked: boolean;
  human: boolean;
  active: 'none' | 'human' | 'automatic';
  batch: number[];
  submitted: boolean;
  receipts: number[][];
  boundary: number[] | undefined;
};
export type InboxEvent =
  | 'result'
  | 'human'
  | 'schedule'
  | 'submit'
  | 'normal'
  | 'stop'
  | 'failed'
  | 'unreleased'
  | 'restart'
  | 'recover'
  | 'duplicate_release';
export const initialOrchestrationModelState = (): InboxModel => ({
  next: 1,
  queue: [],
  consumed: [],
  pending: [],
  paused: false,
  blocked: false,
  human: false,
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
        if (s.active === 'none' && !s.paused && !s.blocked && !s.human) s.pending = [...s.queue];
      }
      break;
    case 'human':
      s.human = true;
      s.paused = false;
      s.pending = [];
      break;
    case 'schedule':
      if (s.active !== 'none' || s.paused || s.blocked) break;
      if (s.human) {
        s.active = 'human';
        s.human = false;
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
      if (s.active === 'none' || s.submitted || s.paused || s.blocked) break;
      if (s.active === 'automatic' && (!s.batch.length || s.human)) break;
      if (s.batch.length) s.receipts.push([...s.batch]);
      s.submitted = true;
      break;
    case 'normal':
      if (s.active === 'none' || s.blocked || !s.submitted) break;
      consume();
      s.boundary = [...s.queue];
      s.pending = s.paused || s.human ? [] : [...s.queue];
      release();
      break;
    case 'stop':
      s.paused = true;
      s.human = false;
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
    case 'unreleased':
      if (s.active === 'none') break;
      consume();
      s.blocked = true;
      s.pending = [];
      break;
    case 'restart':
      if (s.active !== 'none') {
        consume();
        s.blocked = true;
        s.pending = [];
      }
      break;
    case 'recover':
      if (s.blocked) {
        s.blocked = false;
        release();
      }
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
    'schedule',
    'submit',
    'normal',
    'stop',
    'failed',
    'unreleased',
    'restart',
    'recover',
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
