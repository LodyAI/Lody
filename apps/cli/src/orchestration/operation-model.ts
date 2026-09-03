/**
 * Small executable contract model for Operation/Delivery scheduling races.
 * It deliberately omits storage fields and models only state that can change a
 * safety or liveness decision. Tests exhaustively explore bounded traces.
 */
export type OrchestrationModelState = {
  operation: 'absent' | 'active' | 'finished';
  targetInput: 'absent' | 'missing' | 'retry_scheduled' | 'durable';
  delivery: 'absent' | 'pending' | 'attempting' | 'consumed';
  deliveryAttempts: number;
  activeTurn: 'none' | 'user' | 'delivery';
  queuedUsers: number;
  archived: boolean;
  configurationAvailable: boolean;
  completionTurnWrites: number;
  chainDepth: number;
};

export type OrchestrationModelAction =
  | 'accept'
  | 'materialize_fail'
  | 'materialization_retry'
  | 'materialize_success'
  | 'finish'
  | 'deadline'
  | 'enqueue_user'
  | 'schedule'
  | 'complete_turn'
  | 'fail_turn'
  | 'interrupt_turn'
  | 'restart'
  | 'archive'
  | 'restore'
  | 'delete_configuration';

export const initialOrchestrationModelState = (): OrchestrationModelState => ({
  operation: 'absent',
  targetInput: 'absent',
  delivery: 'absent',
  deliveryAttempts: 0,
  activeTurn: 'none',
  queuedUsers: 0,
  archived: false,
  configurationAvailable: true,
  completionTurnWrites: 0,
  chainDepth: 0,
});

export const stepOrchestrationModel = (
  state: OrchestrationModelState,
  action: OrchestrationModelAction
): OrchestrationModelState => {
  const next = { ...state };
  switch (action) {
    case 'accept':
      if (next.operation === 'absent' && next.chainDepth < 5) {
        next.operation = 'active';
        next.targetInput = 'missing';
      }
      break;
    case 'materialize_fail':
      if (next.operation === 'active' && next.targetInput === 'missing') {
        next.targetInput = 'retry_scheduled';
      }
      break;
    case 'materialization_retry':
      if (next.operation === 'active' && next.targetInput === 'retry_scheduled') {
        next.targetInput = 'missing';
      }
      break;
    case 'materialize_success':
      if (
        next.operation === 'active' &&
        (next.targetInput === 'missing' || next.targetInput === 'retry_scheduled')
      ) {
        next.targetInput = 'durable';
      }
      break;
    case 'finish':
      if (next.operation === 'active' && next.targetInput === 'durable') {
        next.operation = 'finished';
        next.delivery = 'pending';
      }
      break;
    case 'deadline':
      if (next.operation === 'active') {
        next.operation = 'finished';
        if (next.targetInput === 'retry_scheduled') next.targetInput = 'missing';
        next.delivery = 'pending';
      }
      break;
    case 'enqueue_user':
      next.queuedUsers = Math.min(2, next.queuedUsers + 1);
      break;
    case 'schedule':
      if (next.archived || next.activeTurn !== 'none') break;
      if (next.queuedUsers > 0) {
        next.queuedUsers -= 1;
        next.activeTurn = 'user';
      } else if (next.delivery === 'pending') {
        if (!next.configurationAvailable || next.deliveryAttempts >= 2) {
          next.completionTurnWrites = Math.max(1, next.completionTurnWrites);
          next.delivery = 'consumed';
        } else {
          next.completionTurnWrites = Math.max(1, next.completionTurnWrites);
          next.delivery = 'attempting';
          if (next.deliveryAttempts === 0) {
            next.chainDepth += 1;
          }
          next.deliveryAttempts += 1;
          next.activeTurn = 'delivery';
        }
      }
      break;
    case 'complete_turn':
      if (next.activeTurn === 'delivery' && next.delivery === 'attempting') {
        next.delivery = 'consumed';
      }
      next.activeTurn = 'none';
      break;
    case 'fail_turn':
      if (next.activeTurn === 'delivery' && next.delivery === 'attempting') {
        next.delivery = 'consumed';
      }
      next.activeTurn = 'none';
      break;
    case 'interrupt_turn':
      if (next.activeTurn === 'delivery' && next.delivery === 'attempting') {
        next.delivery = 'pending';
      }
      next.activeTurn = 'none';
      break;
    case 'restart':
      if (next.delivery === 'attempting') {
        next.delivery = 'pending';
      }
      next.activeTurn = 'none';
      break;
    case 'archive':
      next.archived = true;
      break;
    case 'restore':
      next.archived = false;
      break;
    case 'delete_configuration':
      next.configurationAvailable = false;
      break;
  }
  return next;
};

export const assertOrchestrationModelSafety = (state: OrchestrationModelState): void => {
  if (state.completionTurnWrites > 1) {
    throw new Error('one Delivery created more than one visible completion Turn');
  }
  if (state.delivery === 'pending' && state.operation !== 'finished') {
    throw new Error('a pending Delivery exists without a finished Operation');
  }
  if (state.operation === 'absent' && state.targetInput !== 'absent') {
    throw new Error('target materialization exists before Operation acceptance');
  }
  if (state.operation === 'finished' && state.targetInput === 'retry_scheduled') {
    throw new Error('a terminal Operation retained a materialization retry');
  }
  if (state.activeTurn === 'delivery' && state.delivery !== 'attempting') {
    throw new Error('a Delivery continuation is active without a durable attempt claim');
  }
  if (state.deliveryAttempts > 2) {
    throw new Error('a Delivery exceeded its bounded attempt count');
  }
  if (state.chainDepth > 5) {
    throw new Error('machine-originated chain exceeded the fixed depth cap');
  }
};

export const enumerateOrchestrationModel = (maxDepth: number): OrchestrationModelState[] => {
  const actions: OrchestrationModelAction[] = [
    'accept',
    'materialize_fail',
    'materialization_retry',
    'materialize_success',
    'finish',
    'deadline',
    'enqueue_user',
    'schedule',
    'complete_turn',
    'fail_turn',
    'interrupt_turn',
    'restart',
    'archive',
    'restore',
    'delete_configuration',
  ];
  const initial = initialOrchestrationModelState();
  const seen = new Map([[JSON.stringify(initial), initial]]);
  let frontier = [initial];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const nextFrontier: OrchestrationModelState[] = [];
    for (const state of frontier) {
      for (const action of actions) {
        const next = stepOrchestrationModel(state, action);
        assertOrchestrationModelSafety(next);
        const key = JSON.stringify(next);
        if (!seen.has(key)) {
          seen.set(key, next);
          nextFrontier.push(next);
        }
      }
    }
    frontier = nextFrontier;
  }
  return [...seen.values()];
};
