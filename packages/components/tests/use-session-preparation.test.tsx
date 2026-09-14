import { createSessionSendResources } from '../src/lib/session-send-resources';
// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigCliType,
  MachineId,
  SessionId,
  SessionPreparationSpec,
  SessionPrepareResponse,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  type SessionPreparationController,
  useSessionPreparation,
} from '../src/hooks/use-session-preparation';

type PreparationInput = Parameters<typeof useSessionPreparation>[0];

const owners: ReturnType<typeof createSessionSendResources>[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root && container) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
  vi.useRealTimers();
});

describe('useSessionPreparation', () => {
  it('debounces an identifier-only preparation and cancels after renewed activity becomes idle', async () => {
    const { input, requestSessionPrepare, requestSessionPrepareCancel, ensureSessionId } =
      createInput();

    render(<PreparationHarness input={input} />);
    await advance(649);
    expect(requestSessionPrepare).not.toHaveBeenCalled();

    await advance(1);
    expect(requestSessionPrepare).toHaveBeenCalledTimes(1);
    expect(ensureSessionId).toHaveBeenCalledTimes(1);
    const [machineId, spec, options] = requestSessionPrepare.mock.calls[0]!;
    expect(machineId).toBe(input.machineId);
    expect(spec).toEqual({
      preparationId: expect.any(String),
      sessionId: 'session-draft',
      requestedByUserId: 'user-1',
      agentConfigId: 'agent-1',
      cliType: 'builtin',
      agentType: 'codex',
      project: undefined,
      runConfig: undefined,
    });
    expect(options).toEqual({ timeoutMs: 5_000 });
    expect(Object.keys(spec).sort()).toEqual(
      [
        'agentConfigId',
        'agentType',
        'cliType',
        'preparationId',
        'project',
        'requestedByUserId',
        'runConfig',
        'sessionId',
      ].sort()
    );

    await advance(20_000);
    render(<PreparationHarness input={{ ...input, activityRevision: 1 }} />);
    await advance(29_999);
    expect(requestSessionPrepareCancel).not.toHaveBeenCalled();

    await advance(1);
    expect(requestSessionPrepareCancel).toHaveBeenCalledTimes(1);
    expect(requestSessionPrepareCancel).toHaveBeenCalledWith(
      input.machineId,
      {
        preparationId: spec.preparationId,
        sessionId: spec.sessionId,
        requestedByUserId: input.requestedByUserId,
      },
      { timeoutMs: 5_000 }
    );
  });

  it('does not let cancellation overtake an unsettled start request', async () => {
    const start = deferred<SessionPrepareResponse | null>();
    const setup = createInput();
    setup.requestSessionPrepare.mockImplementationOnce(async () => await start.promise);

    render(<PreparationHarness input={setup.input} />);
    await advance(650);
    const firstSpec = setup.requestSessionPrepare.mock.calls[0]![1];

    render(
      <PreparationHarness
        input={{
          ...setup.input,
          agentConfigId: 'agent-2' as AgentConfigId,
        }}
      />
    );
    expect(setup.requestSessionPrepareCancel).not.toHaveBeenCalled();

    await act(async () => {
      start.resolve(acceptedResponse(firstSpec));
      await flushMicrotasks();
    });
    expect(setup.requestSessionPrepareCancel).toHaveBeenCalledTimes(1);
    expect(setup.requestSessionPrepareCancel.mock.calls[0]![1].preparationId).toBe(
      firstSpec.preparationId
    );
  });

  it('replaces the preparation when the selected run configuration changes', async () => {
    const setup = createInput();
    const firstInput = {
      ...setup.input,
      runConfig: {
        modelId: 'model-a',
        configOptionValues: { effort: 'high' },
      },
    };

    render(<PreparationHarness input={firstInput} />);
    await advance(650);
    const firstSpec = setup.requestSessionPrepare.mock.calls[0]![1];
    expect(firstSpec.runConfig).toEqual({
      modelId: 'model-a',
      configOptionValues: { effort: 'high' },
    });

    render(
      <PreparationHarness
        input={{
          ...firstInput,
          runConfig: {
            modelId: 'model-b',
            configOptionValues: { effort: 'medium' },
          },
        }}
      />
    );
    await act(async () => await flushMicrotasks());
    expect(setup.requestSessionPrepareCancel).toHaveBeenCalledWith(
      setup.input.machineId,
      {
        preparationId: firstSpec.preparationId,
        sessionId: firstSpec.sessionId,
        requestedByUserId: setup.input.requestedByUserId,
      },
      { timeoutMs: 5_000 }
    );

    await advance(650);
    expect(setup.requestSessionPrepare).toHaveBeenCalledTimes(2);
    expect(setup.requestSessionPrepare.mock.calls[1]![1].runConfig).toEqual({
      modelId: 'model-b',
      configOptionValues: { effort: 'medium' },
    });
  });

  it('retires a rejected intent and retries on later draft activity', async () => {
    const setup = createInput();
    setup.requestSessionPrepare.mockImplementationOnce(async (_machineId, spec) => ({
      ...acceptedResponse(spec),
      accepted: false,
      disposition: 'busy',
    }));

    render(<PreparationHarness input={setup.input} />);
    await advance(650);
    expect(setup.requestSessionPrepareCancel).toHaveBeenCalledTimes(1);

    render(<PreparationHarness input={{ ...setup.input, activityRevision: 1 }} />);
    await advance(650);
    expect(setup.requestSessionPrepare).toHaveBeenCalledTimes(2);
  });
  it('hands an active lease to the durable session without cancelling on draft cleanup', async () => {
    const setup = createInput();
    let controller: SessionPreparationController | null = null;

    render(
      <PreparationHarness input={setup.input} onController={(value) => (controller = value)} />
    );
    await advance(650);
    const preparedSessionId = setup.requestSessionPrepare.mock.calls[0]![1].sessionId;

    expect(controller?.handoffToSession(preparedSessionId)).toBe(true);
    render(
      <PreparationHarness
        input={{ ...setup.input, enabled: false }}
        onController={(value) => (controller = value)}
      />
    );
    await act(async () => {
      root?.unmount();
      root = null;
      await flushMicrotasks();
    });

    expect(setup.requestSessionPrepareCancel).not.toHaveBeenCalled();
  });
});

function createInput(): {
  input: PreparationInput;
  requestSessionPrepare: ReturnType<typeof vi.fn<WorkspaceRuntime['requestSessionPrepare']>>;
  requestSessionPrepareCancel: ReturnType<
    typeof vi.fn<WorkspaceRuntime['requestSessionPrepareCancel']>
  >;
  ensureSessionId: ReturnType<typeof vi.fn<() => SessionId>>;
} {
  const requestSessionPrepare = vi.fn<WorkspaceRuntime['requestSessionPrepare']>(
    async (_machineId, spec) => acceptedResponse(spec)
  );
  const requestSessionPrepareCancel = vi.fn<WorkspaceRuntime['requestSessionPrepareCancel']>(
    async (_machineId, args) => ({
      type: 'session/prepare-cancel_response',
      preparationId: args.preparationId,
      sessionId: args.sessionId,
      cancelled: true,
      disposition: 'cancelled',
    })
  );
  const sendResources = createSessionSendResources({
    acquire: async () => {
      throw new Error('Unexpected borrow');
    },
    releaseRef: () => {},
  });
  owners.push(sendResources);
  const runtime = {
    sendResources,
    requestSessionPrepare,
    requestSessionPrepareCancel,
  } as WorkspaceRuntime;
  const ensureSessionId = vi.fn<() => SessionId>(() => 'session-draft' as SessionId);
  return {
    requestSessionPrepare,
    requestSessionPrepareCancel,
    ensureSessionId,
    input: {
      runtime,
      machineId: 'machine-1' as MachineId,
      requestedByUserId: 'user-1',
      agentConfigId: 'agent-1' as AgentConfigId,
      cliType: 'builtin' as AgentConfigCliType,
      agentType: 'codex',
      sessionId: null,
      ensureSessionId,
      enabled: true,
      activityRevision: 0,
    },
  };
}

function acceptedResponse(spec: SessionPreparationSpec): SessionPrepareResponse {
  return {
    type: 'session/prepare_response',
    preparationId: spec.preparationId,
    sessionId: spec.sessionId,
    accepted: true,
    disposition: 'accepted',
  };
}

function PreparationHarness({
  input,
  onController,
}: {
  input: PreparationInput;
  onController?: (controller: SessionPreparationController) => void;
}): null {
  const controller = useSessionPreparation(input);
  onController?.(controller);
  return null;
}

function render(node: ReactNode): void {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
  }
  if (!root) {
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushMicrotasks();
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
