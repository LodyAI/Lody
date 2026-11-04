/** Independent action oracle. Inputs are witnessed facts; no production policy
 * or expected-result fields participate in a prediction. */
import { refWriteExpectation, type RefState, type RefExpectation } from './reference-model';
import type { JudgeVerdict } from './judge';

export interface RefAction {
  readonly kind: string;
  readonly operation?: string;
  readonly command?: { readonly operation: string };
  readonly target?: string;
  readonly role?: string;
}
export interface RefActionPrediction {
  readonly expected: RefExpectation;
  readonly rule: string;
  readonly domain: 'protocol' | 'local' | 'harness';
  readonly nextEpoch?: number;
  readonly noKeySend?: boolean;
  readonly transition?: {
    readonly deviceAbsent?: string;
    readonly userAbsent?: string;
    readonly userRole?: { readonly user: string; readonly role: string };
    readonly epoch?: number;
    readonly rotationRequired?: boolean;
  };
}
export function refActionPrediction(input: {
  readonly state: RefState;
  readonly actor: string;
  readonly action: RefAction;
  readonly running: boolean;
  readonly targetDevice?: string;
  readonly targetUser?: string;
}): RefActionPrediction {
  const { state, actor, action, running } = input;
  const active = !state.revoked.has(actor) ? state.devices.get(actor) : undefined;
  const predict = (
    expected: RefExpectation,
    rule: string,
    domain: RefActionPrediction['domain'] = 'protocol'
  ) => ({ expected, rule, domain });
  const yes = (rule: string, domain?: RefActionPrediction['domain']) =>
    predict('allow', rule, domain);
  const no = (rule: string, domain?: RefActionPrediction['domain']) =>
    predict('deny', rule, domain);
  if (['transport', 'storage', 'measure'].includes(action.kind))
    return yes('explicit-harness-instrumentation', 'harness');
  if (action.kind === 'crash') return yes('stop-is-idempotent', 'local');
  if (action.kind === 'start')
    return running
      ? no('single-live-owner', 'local')
      : yes('open-retained-local-owner-does-not-grant-current-authority', 'local');
  if (action.kind === 'begin-call')
    return yes('start-owned-call-without-claiming-completion', 'local');
  if (action.kind === 'join-call')
    return predict('unmeasured', 'requires-original-call-prediction', 'local');
  if (!running) return no('operation-requires-live-owner', 'local');
  if (action.kind === 'attack') return yes('explicit-local-fault', 'harness');
  const operation =
    action.kind === 'key-command'
      ? action.command?.operation
      : action.kind === 'persist'
        ? 'persist'
        : action.operation;
  if (
    [
      'observe',
      'persist',
      'acknowledge',
      'edit-offline',
      'key-results',
      'acknowledge-key-result',
      'acknowledge-epoch-rotation',
    ].includes(operation ?? '')
  )
    return yes('local-state-does-not-grant-new-network-authority', 'local');
  if (operation === 'refresh')
    return yes('authenticated-historical-device-sees-control-revocation');
  if (!active) return no('current-device-required');
  if (['append', 'create', 'upload-snapshot', 'flush-offline'].includes(operation ?? ''))
    return predict(
      refWriteExpectation(state, actor, state.org, state.epoch),
      'current-content-writer'
    );
  if (operation === 'keys')
    return { ...yes('active-device-receive'), noKeySend: active.kind === 'recovery' };
  if (['repair', 'pull', 'recover', 'refresh', 'resume'].includes(operation ?? ''))
    return yes('active-device-read-or-receive');
  if (['rotate-epoch', 'publish-without-stage'].includes(operation ?? '')) {
    if (active.kind !== 'personal' || !['owner', 'admin'].includes(active.role))
      return no('personal-manager-rotation');
    if (operation === 'publish-without-stage')
      return state.epoch < 0xffffffff
        ? {
            ...yes('noncompliant-manager-may-submit-but-staging-property-measures-availability'),
            nextEpoch: state.epoch + 1,
          }
        : no('epoch-overflow');
    if (state.rotationRequired === undefined)
      return predict('unmeasured', 'missing-rotation-observation');
    return state.rotationRequired && state.epoch < 0xffffffff
      ? {
          ...yes('required-rotation'),
          nextEpoch: state.epoch + 1,
          transition: { epoch: state.epoch + 1, rotationRequired: false },
        }
      : no('rotation-must-be-required-and-finite');
  }
  if (operation === 'resume-epoch-rotation')
    return yes('resume-original-may-report-conflict-without-authorizing-new-record');
  if (operation === 'remove-member-and-rotate') {
    if (active.kind !== 'personal' || active.role !== 'owner') return no('owner-personal-removal');
    if (!input.targetUser) return predict('unmeasured', 'missing-target-membership');
    return input.targetUser !== state.ownerUser && state.epoch < 0xffffffff
      ? {
          ...yes('non-owner-atomic-removal'),
          nextEpoch: state.epoch + 1,
          transition: {
            userAbsent: input.targetUser,
            epoch: state.epoch + 1,
            rotationRequired: false,
          },
        }
      : no('cannot-remove-owner-or-overflow');
  }
  if (operation === 'set-role') {
    if (active.kind !== 'personal' || active.role !== 'owner')
      return no('owner-personal-role-change');
    if (!input.targetUser) return predict('unmeasured', 'missing-target-membership');
    return input.targetUser !== state.ownerUser &&
      ['admin', 'member', 'guest'].includes(action.role ?? '')
      ? {
          ...yes('non-owner-role-change'),
          transition: { userRole: { user: input.targetUser, role: action.role! } },
        }
      : no('cannot-change-owner-role');
  }
  if (operation === 'revoke') {
    const target = input.targetDevice ? state.devices.get(input.targetDevice) : undefined;
    if (!target) return no('active-revocation-target-required');
    if (active.kind !== 'personal' || active.user !== target.user)
      return no('self-user-personal-revocation');
    if (
      target.user === state.ownerUser &&
      (target.kind === 'personal' || target.kind === 'recovery')
    ) {
      const remains = [...state.devices.values()].some(
        (row) =>
          row.id !== target.id &&
          !state.revoked.has(row.id) &&
          row.user === target.user &&
          (row.kind === 'personal' || row.kind === 'recovery')
      );
      if (!remains) return no('owner-retains-management-device');
    }
    return {
      ...yes('self-user-personal-revocation'),
      transition: { deviceAbsent: target.id, rotationRequired: true },
    };
  }
  return predict('unmeasured', 'unknown-action');
}

/** An unrelated transport/SQL/crypto failure is never proof of permission
 * enforcement. Allowed operations may be blocked by an injected host fault. */
export function judgeRefAction(
  prediction: RefActionPrediction,
  reply: {
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: { readonly tag: string; readonly code: string };
  },
  post?: RefState
): JudgeVerdict {
  if (prediction.expected === 'unmeasured') return 'unavailable';
  if (reply.ok) {
    const outcome =
      reply.value && typeof reply.value === 'object' && 'outcome' in reply.value
        ? reply.value.outcome
        : undefined;
    if (prediction.expected === 'deny')
      return outcome === 'Conflict' || outcome === 'Pending' ? 'unavailable' : 'violation';
    if (prediction.noKeySend) {
      if (!reply.value || typeof reply.value !== 'object' || !('scheduled' in reply.value))
        return 'unavailable';
      if (reply.value.scheduled !== 0) return 'violation';
    }
    if (
      prediction.nextEpoch !== undefined &&
      reply.value &&
      typeof reply.value === 'object' &&
      'outcome' in reply.value &&
      reply.value.outcome === 'Committed'
    ) {
      if (!('epoch' in reply.value)) return 'unavailable';
      if (reply.value.epoch !== prediction.nextEpoch) return 'violation';
    }
    if (
      prediction.transition &&
      outcome !== 'Committed' &&
      outcome !== 'Conflict' &&
      outcome !== 'Pending'
    )
      return 'harness-error';
    if (prediction.transition && outcome === 'Committed') {
      if (!post) return 'unavailable';
      const transition = prediction.transition;
      if (
        transition.deviceAbsent &&
        post.devices.has(transition.deviceAbsent) &&
        !post.revoked.has(transition.deviceAbsent)
      )
        return 'violation';
      if (
        transition.userAbsent &&
        [...post.devices.values()].some(
          (device) => device.user === transition.userAbsent && !post.revoked.has(device.id)
        )
      )
        return 'violation';
      if (transition.userRole) {
        const targets = [...post.devices.values()].filter(
          (device) => device.user === transition.userRole!.user && !post.revoked.has(device.id)
        );
        if (!targets.length) return 'unavailable';
        if (targets.some((device) => device.role !== transition.userRole!.role)) return 'violation';
      }
      if (transition.epoch !== undefined && post.epoch !== transition.epoch) return 'violation';
      if (
        transition.rotationRequired !== undefined &&
        post.rotationRequired !== transition.rotationRequired
      )
        return 'violation';
    }
    return 'pass';
  }
  const error = reply.error;
  if (
    prediction.expected === 'deny' &&
    prediction.domain === 'local' &&
    error?.tag === 'LabProcessError' &&
    ['closed', 'not-started', 'already-started'].includes(error.code)
  )
    return 'pass';
  if (
    !error ||
    ['LabActionError', 'LabProcessError'].includes(error.tag) ||
    ['invalid-command', 'invalid-plan', 'invalid-configuration', 'missing-observation'].includes(
      error.code
    )
  )
    return 'harness-error';
  const localPermission = [
    'LedgerError',
    'ContentError',
    'WorkspaceError',
    'EpochRotationError',
  ].includes(error.tag);
  const permissionRefusal =
    localPermission &&
    [
      'unauthorized',
      'forbidden',
      'revoked',
      'rotation-required',
      'permission',
      'not-authorized',
    ].includes(error.code);
  if (prediction.expected === 'deny')
    return permissionRefusal ||
      (prediction.domain === 'local' &&
        ['closed', 'not-started', 'already-started'].includes(error.code))
      ? 'pass'
      : 'unavailable';
  return permissionRefusal ? 'violation' : 'unavailable'; // A remote 401/403 is availability, never a policy mismatch.
}

/** No action linearization point is inferred from its RPC start or join. Retain
 * both independently witnessed predictions; a permission change is uncertainty,
 * while unchanged predictions and independent property checks remain measured. */
export function judgeConcurrentRefAction(
  before: RefActionPrediction,
  atJoin: RefActionPrediction,
  reply: Parameters<typeof judgeRefAction>[1],
  post: RefState
): JudgeVerdict {
  const prior = judgeRefAction(before, reply, post);
  const current = judgeRefAction(atJoin, reply, post);
  const permission = (value: RefActionPrediction) =>
    JSON.stringify({
      expected: value.expected,
      domain: value.domain,
      nextEpoch: value.nextEpoch,
      noKeySend: value.noKeySend,
      transition: value.transition,
    });
  if (permission(before) === permission(atJoin)) return prior;
  if (prior === 'harness-error' || current === 'harness-error') return 'harness-error';
  return 'unavailable';
}
