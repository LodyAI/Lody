/**
 * Small executable contract model for Operation/Delivery scheduling races.
 * It deliberately omits storage fields and models only state that can change a
 * safety or liveness decision. Tests exhaustively explore bounded traces.
 */
export type OrchestrationModelState = {
  operation: 'absent' | 'active' | 'finished';
  targetInput: 'absent' | 'missing' | 'retry_scheduled' | 'durable';
  delivery:
    | 'absent'
    | 'pending'
    | 'claimed'
    | 'prepared'
    | 'started'
    | 'uncertain'
    | 'finalizing'
    | 'uncertain_finalizing'
    | 'consumed';
  deliveryClaimOwner: 'none' | 'current' | 'previous';
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
  | 'prepare_turn'
  | 'start_turn'
  | 'history_write_fail'
  | 'complete_turn'
  | 'fail_turn'
  | 'interrupt_turn'
  | 'cancel_turn'
  | 'complete_finalization'
  | 'finalization_consume_fail'
  | 'restart'
  | 'recover_orphans'
  | 'archive'
  | 'restore'
  | 'delete_configuration';

export const initialOrchestrationModelState = (): OrchestrationModelState => ({
  operation: 'absent',
  targetInput: 'absent',
  delivery: 'absent',
  deliveryClaimOwner: 'none',
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
      } else if (next.delivery === 'uncertain') {
        next.delivery = 'uncertain_finalizing';
        next.deliveryClaimOwner = 'current';
      } else if (next.delivery === 'pending') {
        if (!next.configurationAvailable || next.deliveryAttempts >= 2) {
          next.delivery = 'finalizing';
          next.deliveryClaimOwner = 'current';
        } else {
          next.delivery = 'claimed';
          next.deliveryClaimOwner = 'current';
          next.activeTurn = 'delivery';
        }
      }
      break;
    case 'prepare_turn':
      if (
        next.activeTurn === 'delivery' &&
        next.delivery === 'claimed' &&
        next.deliveryClaimOwner === 'current' &&
        next.deliveryAttempts < 2
      ) {
        next.completionTurnWrites = Math.max(1, next.completionTurnWrites);
        next.delivery = 'prepared';
        if (next.deliveryAttempts === 0) {
          next.chainDepth += 1;
        }
        next.deliveryAttempts += 1;
      }
      break;
    case 'start_turn':
      if (
        next.activeTurn === 'delivery' &&
        next.delivery === 'prepared' &&
        next.deliveryClaimOwner === 'current'
      ) {
        next.delivery = 'started';
      }
      break;
    case 'history_write_fail':
      if (
        next.activeTurn === 'delivery' &&
        next.delivery === 'claimed' &&
        next.deliveryClaimOwner === 'current'
      ) {
        next.delivery = 'pending';
        next.deliveryClaimOwner = 'none';
        next.activeTurn = 'none';
      }
      break;
    case 'complete_turn':
      if (
        next.activeTurn === 'delivery' &&
        (next.delivery === 'prepared' || next.delivery === 'started')
      ) {
        next.delivery = 'consumed';
        next.deliveryClaimOwner = 'none';
      }
      next.activeTurn = 'none';
      break;
    case 'fail_turn':
      if (
        next.activeTurn === 'delivery' &&
        (next.delivery === 'prepared' || next.delivery === 'started')
      ) {
        next.delivery = 'consumed';
        next.deliveryClaimOwner = 'none';
      }
      next.activeTurn = 'none';
      break;
    case 'interrupt_turn':
      if (next.activeTurn === 'delivery' && next.delivery === 'started') {
        next.delivery = 'uncertain';
        next.deliveryClaimOwner = 'none';
      } else if (
        next.activeTurn === 'delivery' &&
        (next.delivery === 'claimed' || next.delivery === 'prepared')
      ) {
        next.delivery = 'pending';
        next.deliveryClaimOwner = 'none';
      }
      next.activeTurn = 'none';
      break;
    case 'cancel_turn':
      if (
        next.activeTurn === 'delivery' &&
        (next.delivery === 'claimed' || next.delivery === 'prepared' || next.delivery === 'started')
      ) {
        next.delivery = 'consumed';
        next.deliveryClaimOwner = 'none';
      }
      next.activeTurn = 'none';
      break;
    case 'finalization_consume_fail':
      if (
        (next.delivery === 'finalizing' || next.delivery === 'uncertain_finalizing') &&
        next.deliveryClaimOwner === 'current'
      ) {
        next.completionTurnWrites = Math.max(1, next.completionTurnWrites);
      }
      break;
    case 'complete_finalization':
      if (
        (next.delivery === 'finalizing' || next.delivery === 'uncertain_finalizing') &&
        next.deliveryClaimOwner === 'current'
      ) {
        next.completionTurnWrites = Math.max(1, next.completionTurnWrites);
        next.delivery = 'consumed';
        next.deliveryClaimOwner = 'none';
      }
      break;
    case 'restart':
      if (
        (next.delivery === 'claimed' ||
          next.delivery === 'prepared' ||
          next.delivery === 'started' ||
          next.delivery === 'finalizing' ||
          next.delivery === 'uncertain_finalizing') &&
        next.deliveryClaimOwner === 'current'
      ) {
        next.deliveryClaimOwner = 'previous';
      }
      next.activeTurn = 'none';
      break;
    case 'recover_orphans':
      if (
        (next.delivery === 'claimed' ||
          next.delivery === 'prepared' ||
          next.delivery === 'started' ||
          next.delivery === 'finalizing' ||
          next.delivery === 'uncertain_finalizing') &&
        next.deliveryClaimOwner === 'previous'
      ) {
        next.delivery =
          next.delivery === 'started' || next.delivery === 'uncertain_finalizing'
            ? 'uncertain'
            : 'pending';
        next.deliveryClaimOwner = 'none';
      }
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
  if (
    state.activeTurn === 'delivery' &&
    state.delivery !== 'claimed' &&
    state.delivery !== 'prepared' &&
    state.delivery !== 'started'
  ) {
    throw new Error('a Delivery continuation is active without a durable attempt claim');
  }
  if (
    (state.delivery === 'claimed' ||
      state.delivery === 'prepared' ||
      state.delivery === 'started' ||
      state.delivery === 'finalizing' ||
      state.delivery === 'uncertain_finalizing') !==
    (state.deliveryClaimOwner !== 'none')
  ) {
    throw new Error('Delivery claim state and its fenced owner disagree');
  }
  if (state.activeTurn === 'delivery' && state.deliveryClaimOwner !== 'current') {
    throw new Error('a Delivery turn is active under a non-current Worker boot');
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
    'prepare_turn',
    'start_turn',
    'history_write_fail',
    'complete_turn',
    'fail_turn',
    'interrupt_turn',
    'cancel_turn',
    'complete_finalization',
    'finalization_consume_fail',
    'restart',
    'recover_orphans',
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
