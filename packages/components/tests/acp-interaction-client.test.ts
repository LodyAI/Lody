import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAcpInteraction,
  type AcpInteractionTransport,
} from '../src/providers/acp-interaction-client';

const id = 'a'.repeat(32);
const device = 'b'.repeat(64);
const reply = (state: string, extra: object = {}) => ({
  type: 'machine/acp-interaction',
  interactionRequestId: id,
  state,
  ...extra,
});
const setup = (
  transport: AcpInteractionTransport,
  extra: { onProgress?: (value: unknown) => void; maxPolls?: number } = {}
) => {
  let n = 0;
  const sealInput = vi.fn(async (args: unknown) => ({ sealed: args }));
  const open = vi.fn(async ({ envelope }: { envelope: unknown }) => envelope);
  const operation = createAcpInteraction(
    {
      transport,
      sealInput,
      responseRecipient: { publicKey: 'response-public', open },
      newRequestId: () => (n++ === 0 ? id : n.toString(16).padStart(32, '0')),
      parseProgress: (x) => x,
      parseResult: (_, x) => x,
    },
    {
      workspaceId: 'workspace',
      machineId: 'machine',
      configId: 'config',
      kind: 'authenticate',
      timeoutMs: 5000,
      pollIntervalMs: 100,
      requestTimeoutMs: 500,
      maxPolls: extra.maxPolls ?? 3,
      onProgress: extra.onProgress,
    }
  );
  return { operation, sealInput, open };
};

afterEach(() => vi.useRealTimers());

describe('encrypted ACP interaction client', () => {
  it('encrypts both directions with the shared identity contexts', async () => {
    const { createAcpInteractionCrypto } = await import('../src/providers/acp-interaction-crypto');
    const { createRpcSecretRecipient, encryptRpcSecret } = await import('@lody/loro-streams-rpc');
    const { e2eeAcpInteractionResponseContext, e2eeAcpInteractionInputContext } =
      await import('@lody/shared/e2ee-rpc');
    const crypto = await createAcpInteractionCrypto();
    const target = await createRpcSecretRecipient();
    const identity = {
      workspaceId: 'workspace',
      machineId: 'machine',
      requesterDevice: device,
      interactionRequestId: id,
    };
    const response = { ...identity, requestId: 'c'.repeat(32) };
    const envelope = await encryptRpcSecret(
      crypto.responseRecipient.publicKey,
      JSON.stringify({ progress: 'private' }),
      e2eeAcpInteractionResponseContext(response)
    );
    await expect(crypto.responseRecipient.open({ ...response, envelope })).resolves.toEqual({
      progress: 'private',
    });
    await expect(
      crypto.responseRecipient.open({ ...response, requestId: 'd'.repeat(32), envelope })
    ).rejects.toThrow();
    const input = { ...identity, interactionId: 'question' };
    const sealed = await crypto.sealInput({
      ...input,
      publicKey: target.publicKey,
      input: { token: 'private' },
    });
    expect(JSON.parse(await target.decrypt(sealed, e2eeAcpInteractionInputContext(input)))).toEqual(
      { token: 'private' }
    );
    await expect(
      target.decrypt(
        sealed,
        e2eeAcpInteractionInputContext({ ...input, requesterDevice: 'e'.repeat(64) })
      )
    ).rejects.toThrow();
  });
  it('binds start, poll and encrypted input to the host signer and same operation', async () => {
    vi.useFakeTimers();
    const calls: Parameters<AcpInteractionTransport>[0][] = [];
    let progressReady!: () => void;
    const progressSignal = new Promise<void>((resolve) => {
      progressReady = resolve;
    });
    const progress = vi.fn(() => progressReady());
    const transport: AcpInteractionTransport = async (request) => {
      calls.push(request);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      if (request.params.action === 'start') {
        request.onPrepared?.(device);
        return {
          requesterDevice: device,
          response: reply('running', {
            responseEnvelope: { progress: { status: 'input' }, progressCursor: 1 },
            inputPublicKey: 'public',
          }),
        };
      }
      if (request.params.action === 'submit')
        return { requesterDevice: device, response: reply('running') };
      return {
        requesterDevice: device,
        response: reply('completed', {
          responseEnvelope: { result: { kind: 'authenticate', response: { success: true } } },
        }),
      };
    };
    const { operation, sealInput, open } = setup(transport, { onProgress: progress });
    await progressSignal;
    await operation.submit('interaction', { secret: 'value' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(operation.result).resolves.toEqual({ success: true });
    expect(calls[0].requestId).toBe(id);
    expect(calls[0].params).toMatchObject({ responseKey: 'response-public' });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace',
        machineId: 'machine',
        requesterDevice: device,
        interactionRequestId: id,
        requestId: id,
      })
    );
    expect(calls.slice(1).every((call) => call.expectedDevice === device)).toBe(true);
    expect(sealInput).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace',
        machineId: 'machine',
        requesterDevice: device,
        interactionRequestId: id,
        interactionId: 'interaction',
        publicKey: 'public',
      })
    );
    const submitted = calls.find((call) => call.params.action === 'submit');
    expect(submitted?.params).toMatchObject({
      interactionRequestId: id,
      inputEnvelope: { sealed: expect.anything() },
    });
  });

  it('accepts a completed submit receipt and drains queued progress before the final result', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const acks: Array<number | undefined> = [];
    let ready!: () => void;
    const readySignal = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let poll = 0;
    const completed = reply('completed', {
      responseEnvelope: { result: { kind: 'authenticate', response: 'done' } },
    });
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      if (request.params.action === 'start')
        return {
          requesterDevice: device,
          response: reply('running', {
            inputPublicKey: 'public',
            responseEnvelope: { progress: { status: 'input-required' }, progressCursor: 1 },
          }),
        };
      if (request.params.action === 'submit')
        return { requesterDevice: device, response: completed };
      if (request.params.action === 'poll') {
        acks.push(request.params.progressAck);
        if (poll++ === 0)
          return {
            requesterDevice: device,
            response: reply('running', {
              responseEnvelope: {
                progress: { status: 'authorization', userCode: 'CODE' },
                progressCursor: 2,
              },
            }),
          };
        return { requesterDevice: device, response: completed };
      }
      return { requesterDevice: device, response: reply('cancelled') };
    };
    const { operation } = setup(transport, {
      onProgress: (value) => {
        seen.push(value);
        ready();
      },
    });
    await readySignal;
    await expect(operation.submit('input', { action: 'accept' })).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    await expect(operation.result).resolves.toBe('done');
    expect(seen).toEqual([
      { status: 'input-required' },
      { status: 'authorization', userCode: 'CODE' },
    ]);
    expect(acks).toEqual([1, 2]);
  });

  it('keeps an in-flight submit alive when polling sees completion first', async () => {
    vi.useFakeTimers();
    const submitReceipt = Promise.withResolvers<{ requesterDevice: string; response: unknown }>();
    let ready!: () => void;
    const readySignal = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let submitStarted!: () => void;
    const submitStartedSignal = new Promise<void>((resolve) => {
      submitStarted = resolve;
    });
    const completed = reply('completed', {
      responseEnvelope: { result: { kind: 'authenticate', response: 'done' } },
    });
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      if (request.params.action === 'start')
        return {
          requesterDevice: device,
          response: reply('running', {
            inputPublicKey: 'public',
            responseEnvelope: { progress: { status: 'input-required' }, progressCursor: 1 },
          }),
        };
      if (request.params.action === 'submit') {
        submitStarted();
        return submitReceipt.promise;
      }
      return { requesterDevice: device, response: completed };
    };
    const { operation } = setup(transport, { onProgress: () => ready() });
    await readySignal;
    const submitted = operation.submit('input', { action: 'accept' });
    await submitStartedSignal;
    await vi.advanceTimersByTimeAsync(100);
    await expect(operation.result).resolves.toBe('done');
    submitReceipt.resolve({ requesterDevice: device, response: completed });
    await expect(submitted).resolves.toBeUndefined();
  });

  it('rejects untrusted result and cancels only the original operation', async () => {
    const actions: string[] = [];
    const transport: AcpInteractionTransport = async (request) => {
      actions.push(request.params.action);
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      return {
        requesterDevice: device,
        response:
          request.params.action === 'start'
            ? reply('completed', { responseEnvelope: { result: { kind: 'probe', response: {} } } })
            : reply('cancelled'),
      };
    };
    const { operation } = setup(transport);
    await expect(operation.result).rejects.toThrow('Invalid ACP interaction result');
    await vi.waitFor(() => expect(actions).toEqual(['start', 'cancel']));
  });

  it('rejects plaintext progress without forwarding it', async () => {
    const progress = vi.fn();
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      return {
        requesterDevice: device,
        response:
          request.params.action === 'start'
            ? reply('running', { progress: { secret: 'private' } })
            : reply('cancelled'),
      };
    };
    const { operation } = setup(transport, { onProgress: progress });
    await expect(operation.result).rejects.toThrow('Invalid ACP interaction response');
    expect(progress).not.toHaveBeenCalled();
  });

  it('acknowledges ordered progress, suppresses replay and preserves distinct interactions', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const acks: Array<number | undefined> = [];
    let poll = 0;
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      if (request.params.action === 'start')
        return {
          requesterDevice: device,
          response: reply('running', {
            responseEnvelope: {
              progress: { status: 'authorization', userCode: 'CODE' },
              progressCursor: 1,
            },
          }),
        };
      if (request.params.action === 'poll') {
        acks.push(request.params.progressAck);
        poll++;
        if (poll === 1)
          return {
            requesterDevice: device,
            response: reply('running', {
              responseEnvelope: {
                progress: { status: 'authorization', userCode: 'CODE' },
                progressCursor: 1,
              },
            }),
          };
        if (poll === 2)
          return {
            requesterDevice: device,
            response: reply('running', {
              responseEnvelope: {
                progress: { status: 'input-required', interactionId: 'form' },
                progressCursor: 2,
              },
            }),
          };
        return {
          requesterDevice: device,
          response: reply('completed', {
            responseEnvelope: { result: { kind: 'authenticate', response: 'done' } },
          }),
        };
      }
      return { requesterDevice: device, response: reply('cancelled') };
    };
    const { operation } = setup(transport, { onProgress: (value) => seen.push(value) });
    const result = operation.result;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('done');
    expect(seen).toEqual([
      { status: 'authorization', userCode: 'CODE' },
      { status: 'input-required', interactionId: 'form' },
    ]);
    expect(acks).toEqual([1, 1, 2]);
  });

  it('rejects a gap instead of acknowledging unseen progress', async () => {
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      return {
        requesterDevice: device,
        response:
          request.params.action === 'start'
            ? reply('running', {
                responseEnvelope: { progress: { status: 'input' }, progressCursor: 2 },
              })
            : reply('cancelled'),
      };
    };
    const { operation } = setup(transport);
    await expect(operation.result).rejects.toThrow('Invalid ACP interaction progress cursor');
  });

  it('drains progress without a 500ms pause and acknowledges each cursor', async () => {
    vi.useFakeTimers();
    const acks: number[] = [];
    const progress: number[] = [];
    const transport: AcpInteractionTransport = async (request) => {
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      if (request.params.action === 'start')
        return {
          requesterDevice: device,
          response: reply('running', {
            responseEnvelope: { progress: 1, progressCursor: 1 },
          }),
        };
      if (request.params.action === 'poll') {
        const ack = request.params.progressAck ?? 0;
        acks.push(ack);
        if (ack < 3)
          return {
            requesterDevice: device,
            response: reply('running', {
              responseEnvelope: { progress: ack + 1, progressCursor: ack + 1 },
            }),
          };
        return {
          requesterDevice: device,
          response: reply('completed', {
            responseEnvelope: { result: { kind: 'authenticate', response: 'done' } },
          }),
        };
      }
      return { requesterDevice: device, response: reply('cancelled') };
    };
    const { operation } = setup(transport, {
      onProgress: (value) => progress.push(value as number),
    });
    await expect(operation.result).resolves.toBe('done');
    expect(progress).toEqual([1, 2, 3]);
    expect(acks).toEqual([1, 2, 3]);
  });

  it('bounds polling and never sends another start', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transport: AcpInteractionTransport = async (request) => {
      calls.push(request.params.action);
      request.onPrepared?.(device);
      if (request.params.action === 'activate')
        return { requesterDevice: device, response: reply('running') };
      return {
        requesterDevice: device,
        response: reply(request.params.action === 'cancel' ? 'cancelled' : 'running'),
      };
    };
    const { operation } = setup(transport, { maxPolls: 2 });
    const result = operation.result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('ACP interaction poll limit exceeded');
    expect(calls).toEqual(['start', 'activate', 'poll', 'poll', 'cancel']);
  });

  it('does not retry reserve or activate when a restarted daemon has lost the slot', async () => {
    const actions: string[] = [];
    const transport: AcpInteractionTransport = async (request) => {
      actions.push(request.params.action);
      if (request.params.action === 'start') {
        request.onPrepared?.(device);
        return {
          requesterDevice: device,
          response: reply('running', { inputPublicKey: 'public' }),
        };
      }
      if (request.params.action === 'activate') throw new Error('interaction not found');
      return { requesterDevice: device, response: reply('cancelled') };
    };
    const { operation } = setup(transport);
    await expect(operation.result).rejects.toThrow('interaction not found');
    expect(actions).toEqual(['start', 'activate', 'cancel']);
  });

  it('aborts activation if cancelled while its transport is preparing', async () => {
    const activationEntered = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    const actions: string[] = [];
    let activated = false;
    const transport: AcpInteractionTransport = async (request) => {
      actions.push(request.params.action);
      if (request.params.action === 'start') {
        request.onPrepared?.(device);
        return {
          requesterDevice: device,
          response: reply('running', { inputPublicKey: 'public' }),
        };
      }
      if (request.params.action === 'activate') {
        activationEntered.resolve();
        await releaseActivation.promise;
        if (request.signal.aborted) throw new Error('cancelled before activation');
        activated = true;
        return { requesterDevice: device, response: reply('running') };
      }
      return { requesterDevice: device, response: reply('cancelled') };
    };
    const { operation } = setup(transport);
    const result = operation.result.catch((error: unknown) => error);
    await activationEntered.promise;
    await operation.cancel();
    releaseActivation.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(activated).toBe(false);
    expect(actions).toEqual(['start', 'activate', 'cancel']);
  });

  it('does not activate when cancellation follows start preparation', async () => {
    const start = Promise.withResolvers<{ requesterDevice: string; response: unknown }>();
    const prepared = Promise.withResolvers<void>();
    const actions: string[] = [];
    const transport: AcpInteractionTransport = (request) => {
      actions.push(request.params.action);
      if (request.params.action === 'start') {
        request.onPrepared?.(device);
        prepared.resolve();
        return start.promise;
      }
      return Promise.resolve({ requesterDevice: device, response: reply('cancelled') });
    };
    const { operation } = setup(transport);
    const result = operation.result.catch((error) => error);
    await prepared.promise;
    await operation.cancel();
    start.resolve({ requesterDevice: device, response: reply('running') });
    expect(await result).toBeInstanceOf(Error);
    expect(actions).toEqual(['start', 'cancel']);
  });

  it('times out a lost start and cancels using the signer captured before send', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transport: AcpInteractionTransport = (request) => {
      calls.push(request.params.action);
      if (request.params.action === 'start') {
        request.onPrepared?.(device);
        return new Promise(() => {});
      }
      expect(request.expectedDevice).toBe(device);
      return Promise.resolve({ requesterDevice: device, response: reply('cancelled') });
    };
    const { operation } = setup(transport);
    const result = operation.result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toContain('aborted');
    expect(calls).toEqual(['start', 'cancel']);
  });
});
