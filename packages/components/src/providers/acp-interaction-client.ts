export const ACP_INPUT_OUTCOME_UNKNOWN = 'acp_input_outcome_unknown';

export type AcpInteractionKind = 'probe' | 'authenticate';

type InteractionParams =
  | { action: 'start'; kind: 'probe'; configId: string; force?: boolean; responseKey: unknown }
  | {
      action: 'start';
      kind: 'authenticate';
      configId: string;
      methodId?: string;
      responseKey: unknown;
    }
  | { action: 'activate'; interactionRequestId: string }
  | { action: 'poll'; interactionRequestId: string; progressAck?: number }
  | {
      action: 'submit';
      interactionRequestId: string;
      interactionId: string;
      inputEnvelope: unknown;
    }
  | { action: 'cancel'; interactionRequestId: string };

type Reply = {
  type: 'machine/acp-interaction';
  interactionRequestId: string;
  state: 'running' | 'completed' | 'cancelled' | 'expired';
  inputPublicKey?: unknown;
  responseEnvelope?: unknown;
};

/** The transport must seal each request for this machine and reject a signer other
 * than expectedDevice before sending it. Start returns the actual host signer. */
export type AcpInteractionTransport = (request: {
  workspaceId: string;
  machineId: string;
  requestId: string;
  expectedDevice?: string;
  params: InteractionParams;
  signal: AbortSignal;
  onPrepared?: (requesterDevice: string) => void;
}) => Promise<{ requesterDevice: string; response: unknown }>;

export type AcpInteractionDependencies<P, R, I> = {
  transport: AcpInteractionTransport;
  responseRecipient: {
    publicKey: unknown;
    open: (args: {
      workspaceId: string;
      machineId: string;
      requesterDevice: string;
      interactionRequestId: string;
      requestId: string;
      envelope: unknown;
    }) => Promise<unknown>;
  };
  sealInput: (args: {
    workspaceId: string;
    machineId: string;
    requesterDevice: string;
    interactionRequestId: string;
    interactionId: string;
    publicKey: unknown;
    input: I;
  }) => Promise<unknown>;
  parseProgress: (value: unknown) => P;
  parseResult: (kind: AcpInteractionKind, value: unknown) => R;
  newRequestId: () => string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseReply(value: unknown, id: string): Reply {
  if (
    !object(value) ||
    value.type !== 'machine/acp-interaction' ||
    value.interactionRequestId !== id ||
    !['running', 'completed', 'cancelled', 'expired'].includes(String(value.state))
  ) {
    throw new Error('Invalid ACP interaction response');
  }
  if (
    Object.keys(value).some(
      (key) =>
        !['type', 'interactionRequestId', 'state', 'inputPublicKey', 'responseEnvelope'].includes(
          key
        )
    )
  )
    throw new Error('Invalid ACP interaction response');
  if (value.state === 'completed' && value.responseEnvelope === undefined)
    throw new Error('Missing ACP interaction response envelope');
  return value as Reply;
}

/** Detached client bridge. No transport fallback, implicit start retry, or persistent state. */
export function createAcpInteraction<P, R, I>(
  deps: AcpInteractionDependencies<P, R, I>,
  options: {
    workspaceId: string;
    machineId: string;
    kind: AcpInteractionKind;
    configId: string;
    methodId?: string;
    force?: boolean;
    timeoutMs: number;
    pollIntervalMs: number;
    requestTimeoutMs: number;
    maxPolls: number;
    signal?: AbortSignal;
    onProgress?: (progress: P) => void;
  }
) {
  const { workspaceId, machineId, kind } = options;
  if (
    ![options.timeoutMs, options.pollIntervalMs, options.requestTimeoutMs, options.maxPolls].every(
      Number.isFinite
    ) ||
    options.timeoutMs <= 0 ||
    options.pollIntervalMs <= 0 ||
    options.requestTimeoutMs <= 0 ||
    !Number.isInteger(options.maxPolls) ||
    options.maxPolls <= 0
  )
    throw new Error('Invalid ACP interaction limits');
  const id = deps.newRequestId();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Invalid ACP interaction request ID');
  const controller = new AbortController();
  let device: string | undefined;
  let publicKey: unknown;
  let finished = false;
  let pendingSubmissions = 0;
  let started = false;
  let cancelSent = false;
  let progressAck = 0;
  const deadline = setTimeout(() => controller.abort(), options.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();

  const send = async (
    params: InteractionParams,
    requestId: string,
    signal: AbortSignal,
    expectedDevice?: string
  ) => {
    if (signal.aborted) throw new Error('ACP interaction aborted');
    const local = new AbortController();
    const onAbort = () => local.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => local.abort(), options.requestTimeoutMs);
    let rejectAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('ACP interaction request aborted'));
      local.signal.addEventListener('abort', rejectAbort, { once: true });
      if (local.signal.aborted) rejectAbort();
    });
    try {
      const outcome = await Promise.race([
        deps.transport({
          workspaceId,
          machineId,
          requestId,
          expectedDevice,
          params,
          signal: local.signal,
          onPrepared:
            params.action === 'start'
              ? (signer) => {
                  if (!/^[0-9a-f]{64}$/.test(signer) || (device && device !== signer))
                    throw new Error('ACP interaction signer mismatch');
                  device = signer;
                }
              : undefined,
        }),
        interrupted,
      ]);
      if (signal.aborted || local.signal.aborted)
        throw new Error('ACP interaction request aborted');
      if (
        !/^[0-9a-f]{64}$/.test(outcome.requesterDevice) ||
        (expectedDevice && outcome.requesterDevice !== expectedDevice)
      )
        throw new Error('ACP interaction signer mismatch');
      return outcome;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (rejectAbort) local.signal.removeEventListener('abort', rejectAbort);
    }
  };
  const cancel = async () => {
    controller.abort();
    if (!started || cancelSent || finished || !device) return;
    cancelSent = true;
    const cancelController = new AbortController();
    try {
      const response = await send(
        { action: 'cancel', interactionRequestId: id },
        deps.newRequestId(),
        cancelController.signal,
        device
      );
      parseReply(response.response, id);
    } catch {
      // Cancellation is best effort; remote expiry owns eventual cleanup.
    }
  };
  const delay = () =>
    new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) return reject(new Error('ACP interaction aborted'));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('ACP interaction aborted'));
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, options.pollIntervalMs);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  const consume = async (
    raw: unknown,
    requestId: string
  ): Promise<{ done: boolean; value?: R; progressed?: boolean }> => {
    const reply = parseReply(raw, id);
    let content: Record<string, unknown> = {};
    if (reply.responseEnvelope !== undefined) {
      if (!device) throw new Error('ACP interaction signer unavailable');
      let stopWaiting: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        stopWaiting = () => reject(new Error('ACP interaction aborted'));
        controller.signal.addEventListener('abort', stopWaiting, { once: true });
        if (controller.signal.aborted) stopWaiting();
      });
      let opened: unknown;
      try {
        opened = await Promise.race([
          deps.responseRecipient.open({
            workspaceId,
            machineId,
            requesterDevice: device,
            interactionRequestId: id,
            requestId,
            envelope: reply.responseEnvelope,
          }),
          interrupted,
        ]);
      } finally {
        if (stopWaiting) controller.signal.removeEventListener('abort', stopWaiting);
      }
      if (controller.signal.aborted) throw new Error('ACP interaction aborted');
      if (
        !object(opened) ||
        Object.keys(opened).some((key) => !['progress', 'progressCursor', 'result'].includes(key))
      )
        throw new Error('Invalid ACP interaction encrypted content');
      content = opened;
    }
    if (reply.state === 'completed') {
      if (
        !object(content.result) ||
        content.result.kind !== kind ||
        !('response' in content.result)
      )
        throw new Error('Invalid ACP interaction result');
    } else if (content.result !== undefined) throw new Error('Unexpected ACP interaction result');
    if (reply.inputPublicKey !== undefined) publicKey = reply.inputPublicKey;
    let progressed = false;
    if (content.progress !== undefined) {
      const cursor = content.progressCursor;
      if (
        !Number.isSafeInteger(cursor) ||
        (cursor as number) < 1 ||
        (cursor as number) > progressAck + 1
      )
        throw new Error('Invalid ACP interaction progress cursor');
      if (cursor === progressAck + 1) {
        const progress = deps.parseProgress(content.progress);
        options.onProgress?.(progress);
        progressAck = cursor as number;
        progressed = true;
      }
    } else if (content.progressCursor !== undefined) {
      throw new Error('Invalid ACP interaction progress cursor');
    }
    if (reply.state === 'completed')
      return {
        done: true,
        value: deps.parseResult(kind, (content.result as { response: unknown }).response),
      };
    if (reply.state !== 'running') throw new Error(`ACP interaction ${reply.state}`);
    return { done: false, progressed };
  };
  const result = (async () => {
    try {
      if (controller.signal.aborted) throw new Error('ACP interaction aborted');
      started = true;
      const start: InteractionParams =
        kind === 'probe'
          ? {
              action: 'start',
              kind,
              configId: options.configId,
              responseKey: deps.responseRecipient.publicKey,
              ...(options.force === undefined ? {} : { force: options.force }),
            }
          : {
              action: 'start',
              kind,
              configId: options.configId,
              responseKey: deps.responseRecipient.publicKey,
              ...(options.methodId === undefined ? {} : { methodId: options.methodId }),
            };
      const first = await send(start, id, controller.signal);
      if (device && device !== first.requesterDevice)
        throw new Error('ACP interaction signer mismatch');
      device = first.requesterDevice;
      let current = await consume(first.response, id);
      if (!current.done) {
        const activationId = deps.newRequestId();
        const activation = await send(
          { action: 'activate', interactionRequestId: id },
          activationId,
          controller.signal,
          device
        );
        const startProgressed = current.progressed;
        current = await consume(activation.response, activationId);
        if (startProgressed && !current.done) current.progressed = true;
      }
      for (let count = 0; !current.done && count < options.maxPolls; count++) {
        if (!current.progressed) await delay();
        const pollId = deps.newRequestId();
        const next = await send(
          { action: 'poll', interactionRequestId: id, ...(progressAck ? { progressAck } : {}) },
          pollId,
          controller.signal,
          device
        );
        current = await consume(next.response, pollId);
      }
      if (!current.done) throw new Error('ACP interaction poll limit exceeded');
      finished = true;
      if (pendingSubmissions === 0) controller.abort();
      return current.value as R;
    } catch (error) {
      void cancel();
      throw error;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', abort);
    }
  })();
  return {
    interactionRequestId: id,
    result,
    cancel,
    async submit(interactionId: string, input: I): Promise<void> {
      if (
        !device ||
        publicKey === undefined ||
        finished ||
        controller.signal.aborted ||
        !interactionId
      )
        throw new Error('ACP interaction input unavailable');
      const signer = device;
      const sealing = deps.sealInput({
        workspaceId,
        machineId,
        requesterDevice: signer,
        interactionRequestId: id,
        interactionId,
        publicKey,
        input,
      });
      let stopWaiting: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        stopWaiting = () => reject(new Error('ACP interaction aborted'));
        controller.signal.addEventListener('abort', stopWaiting, { once: true });
        if (controller.signal.aborted) stopWaiting();
      });
      let inputEnvelope: unknown;
      try {
        inputEnvelope = await Promise.race([sealing, interrupted]);
      } finally {
        if (stopWaiting) controller.signal.removeEventListener('abort', stopWaiting);
      }
      if (controller.signal.aborted || finished) throw new Error('ACP interaction aborted');
      pendingSubmissions++;
      try {
        let reply: Awaited<ReturnType<typeof send>>;
        try {
          reply = await send(
            { action: 'submit', interactionRequestId: id, interactionId, inputEnvelope },
            deps.newRequestId(),
            controller.signal,
            signer
          );
        } catch {
          throw new Error(ACP_INPUT_OUTCOME_UNKNOWN);
        }
        let parsed: Reply;
        try {
          parsed = parseReply(reply.response, id);
        } catch {
          throw new Error(ACP_INPUT_OUTCOME_UNKNOWN);
        }
        if (parsed.state !== 'running' && parsed.state !== 'completed')
          throw new Error('ACP interaction input rejected');
        // Poll owns progress and the final result, including any items queued before completion.
      } finally {
        pendingSubmissions--;
        if (finished && pendingSubmissions === 0) controller.abort();
      }
    },
  };
}
