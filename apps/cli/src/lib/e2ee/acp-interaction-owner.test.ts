import { describe, expect, it, vi } from 'vitest';
import { createRpcSecretRecipient, encryptRpcSecret } from '@lody/loro-streams-rpc';
import {
  e2eeAcpInteractionInputContext,
  e2eeAcpInteractionResponseContext,
} from '@lody/shared/e2ee-rpc';
import { createAcpInteractionOwner as createRawOwner } from './acp-interaction-owner';

// Existing behavior tests exercise an activated interaction.
const createAcpInteractionOwner: typeof createRawOwner = (options) => {
  const owner = createRawOwner(options);
  return {
    ...owner,
    async handle(params, context) {
      const reply = await owner.handle(params, context);
      if (params.action === 'start' && reply.state === 'running')
        await owner.handle(
          { action: 'activate', interactionRequestId: context.requestId },
          { ...context, requestId: 'f'.repeat(32) }
        );
      return reply;
    },
  };
};

const device = 'a'.repeat(64);
const id = '1'.repeat(32);
const context = (requestId = id, requesterDevice = device) => ({
  requestId,
  requesterDevice,
  expiresAt: Date.now() + 60_000,
});
const identity = {
  workspaceId: 'workspace',
  machineId: 'machine',
  requesterDevice: device,
  interactionRequestId: id,
};

describe('encrypted ACP interaction owner', () => {
  it('reserves without work, fences cancellation and refuses old activation after restart', async () => {
    const initiator = await createRpcSecretRecipient();
    let starts = 0;
    const options: Parameters<typeof createRawOwner>[0] = {
      workspaceId: 'workspace',
      machineId: 'machine',
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      submit: async () => {},
      start: () => {
        starts++;
        return { result: Promise.resolve({ success: true }), cancel: () => {} };
      },
    };
    const first = createRawOwner(options);
    const request = {
      action: 'start' as const,
      kind: 'probe' as const,
      configId: 'config' as never,
      responseKey: initiator.publicKey,
    };
    const reserved = await first.handle(request, context());
    expect(reserved.inputPublicKey).toBeDefined();
    expect(starts).toBe(0);
    await expect(
      first.handle(
        { action: 'activate', interactionRequestId: id },
        context('2'.repeat(32), 'b'.repeat(64))
      )
    ).rejects.toThrow('e2ee_acp_not_found');
    await first.handle({ action: 'cancel', interactionRequestId: id }, context('3'.repeat(32)));
    await expect(
      first.handle({ action: 'activate', interactionRequestId: id }, context('4'.repeat(32)))
    ).rejects.toThrow('e2ee_acp_activation_unavailable');
    await first.close();
    const second = createRawOwner(options);
    await expect(
      second.handle({ action: 'activate', interactionRequestId: id }, context('5'.repeat(32)))
    ).rejects.toThrow('e2ee_acp_not_found');
    await second.handle(request, context());
    expect(starts).toBe(0);
    await second.handle({ action: 'activate', interactionRequestId: id }, context('6'.repeat(32)));
    expect(starts).toBe(1);
    await expect(
      second.handle({ action: 'activate', interactionRequestId: id }, context('7'.repeat(32)))
    ).rejects.toThrow('e2ee_acp_activation_unavailable');
    await second.close();
  });

  it('encrypts progress and results, binds the device and accepts each input only once', async () => {
    const initiator = await createRpcSecretRecipient();
    let finish: (result: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const inputs: string[] = [];
    let progress: (value: unknown) => void = () => {};
    const owner = createAcpInteractionOwner({
      workspaceId: identity.workspaceId,
      machineId: identity.machineId,
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      start: (args) => {
        progress = args.onProgress;
        return { result: raw, cancel: () => finish({ cancelled: true }) };
      },
      submit: async ({ input }) => {
        inputs.push(input);
      },
    });
    const first = await owner.handle(
      {
        action: 'start',
        kind: 'authenticate',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      context()
    );
    expect(first.inputPublicKey).toBeDefined();
    progress({ status: 'input-required', interactionId: 'challenge' });
    const pollId = '2'.repeat(32);
    const poll = await owner.handle({ action: 'poll', interactionRequestId: id }, context(pollId));
    expect(
      JSON.parse(
        await initiator.decrypt(
          poll.responseEnvelope!,
          e2eeAcpInteractionResponseContext({ ...identity, requestId: pollId })
        )
      )
    ).toEqual({
      progress: { status: 'input-required', interactionId: 'challenge' },
      progressCursor: 1,
    });
    await expect(
      owner.handle({ action: 'poll', interactionRequestId: id }, context(pollId, 'b'.repeat(64)))
    ).rejects.toThrow('e2ee_acp_not_found');
    const ciphertext = await encryptRpcSecret(
      first.inputPublicKey!,
      'synthetic input',
      e2eeAcpInteractionInputContext({ ...identity, interactionId: 'challenge' })
    );
    await owner.handle(
      {
        action: 'submit',
        interactionRequestId: id,
        interactionId: 'challenge',
        inputEnvelope: ciphertext,
      },
      context('3'.repeat(32))
    );
    await expect(
      owner.handle(
        {
          action: 'submit',
          interactionRequestId: id,
          interactionId: 'challenge',
          inputEnvelope: ciphertext,
        },
        context('4'.repeat(32))
      )
    ).rejects.toThrow('e2ee_acp_input_replay');
    expect(inputs).toEqual(['synthetic input']);
    finish({ success: true });
    await raw;
    await Promise.resolve();
    const completed = await owner.handle(
      { action: 'poll', interactionRequestId: id, progressAck: 1 },
      context(pollId)
    );
    expect(completed.state).toBe('completed');
    expect(
      JSON.parse(
        await initiator.decrypt(
          completed.responseEnvelope!,
          e2eeAcpInteractionResponseContext({ ...identity, requestId: pollId })
        )
      )
    ).toEqual({ result: { kind: 'authenticate', response: { success: true } } });
    await owner.close();
  });

  it('replays ordered progress until acknowledged and drains it before completion', async () => {
    const initiator = await createRpcSecretRecipient();
    let finish: (value: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let progress: (value: unknown) => void = () => {};
    const owner = createAcpInteractionOwner({
      workspaceId: 'workspace',
      machineId: 'machine',
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      submit: async () => {},
      start: (args) => {
        progress = args.onProgress;
        return { result: raw, cancel: () => {} };
      },
    });
    await owner.handle(
      {
        action: 'start',
        kind: 'authenticate',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      context()
    );
    progress({ status: 'authorization', url: 'https://example.test/device' });
    progress({ status: 'input-required', interactionId: 'code' });
    finish({ success: true });
    await raw;
    const poll = async (requestId: string, progressAck?: number) => {
      const result = await owner.handle(
        {
          action: 'poll',
          interactionRequestId: id,
          ...(progressAck === undefined ? {} : { progressAck }),
        },
        context(requestId)
      );
      const content =
        result.responseEnvelope &&
        JSON.parse(
          await initiator.decrypt(
            result.responseEnvelope,
            e2eeAcpInteractionResponseContext({ ...identity, requestId })
          )
        );
      return { state: result.state, content };
    };
    const first = await poll('2'.repeat(32));
    expect(first).toEqual({
      state: 'running',
      content: {
        progress: { status: 'authorization', url: 'https://example.test/device' },
        progressCursor: 1,
      },
    });
    expect(await poll('3'.repeat(32))).toEqual(first);
    await expect(poll('4'.repeat(32), 2)).rejects.toThrow('e2ee_acp_invalid_ack');
    expect(await poll('5'.repeat(32), 1)).toEqual({
      state: 'running',
      content: { progress: { status: 'input-required', interactionId: 'code' }, progressCursor: 2 },
    });
    expect(await poll('6'.repeat(32), 2)).toEqual({
      state: 'completed',
      content: { result: { kind: 'authenticate', response: { success: true } } },
    });
    await owner.close();
  });

  it('cancels on progress overflow without discarding queued events', async () => {
    const initiator = await createRpcSecretRecipient();
    let finish: (value: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let progress: (value: unknown) => void = () => {};
    let aborted = false;
    const owner = createAcpInteractionOwner({
      workspaceId: 'workspace',
      machineId: 'machine',
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      submit: async () => {},
      start: (args) => {
        progress = args.onProgress;
        args.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return { result: raw, cancel: () => {} };
      },
    });
    await owner.handle(
      {
        action: 'start',
        kind: 'probe',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      context()
    );
    for (let n = 0; n < 33; n++) progress({ n });
    expect(aborted).toBe(true);
    for (let n = 0; n < 32; n++) {
      const requestId = (n + 2).toString(16).padStart(32, '0');
      const reply = await owner.handle(
        { action: 'poll', interactionRequestId: id, progressAck: n },
        context(requestId)
      );
      expect(
        JSON.parse(
          await initiator.decrypt(
            reply.responseEnvelope!,
            e2eeAcpInteractionResponseContext({ ...identity, requestId })
          )
        )
      ).toEqual({ progress: { n }, progressCursor: n + 1 });
    }
    expect(
      (
        await owner.handle(
          { action: 'poll', interactionRequestId: id, progressAck: 32 },
          context('f'.repeat(32))
        )
      ).state
    ).toBe('cancelled');
    finish({});
    await raw;
    await owner.close();
  });

  it('binds early cancellations to the device and expires bounded tombstones', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      let starts = 0;
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        createRecipient: createRpcSecretRecipient,
        encrypt: encryptRpcSecret,
        submit: async () => {},
        start: () => {
          starts++;
          return { result: Promise.resolve({}), cancel: () => {} };
        },
      });
      const request = {
        action: 'start' as const,
        kind: 'probe' as const,
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      };
      expect(
        (
          await owner.handle(
            { action: 'cancel', interactionRequestId: id },
            context('f'.repeat(32))
          )
        ).state
      ).toBe('cancelled');
      await expect(owner.handle(request, context())).rejects.toThrow(
        'e2ee_acp_cancelled_before_start'
      );
      expect(starts).toBe(0);
      for (let n = 0; n < 127; n++)
        await owner.handle(
          { action: 'cancel', interactionRequestId: (n + 2).toString(16).padStart(32, '0') },
          context('f'.repeat(32))
        );
      await expect(
        owner.handle(
          { action: 'cancel', interactionRequestId: 'e'.repeat(32) },
          context('f'.repeat(32))
        )
      ).rejects.toThrow('e2ee_acp_tombstone_capacity');
      await vi.advanceTimersByTimeAsync(900_000);
      await owner.handle(request, context(id, 'b'.repeat(64)));
      expect(starts).toBe(1);
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces download snapshots while keeping delivered events and authentication prompts ordered', async () => {
    const initiator = await createRpcSecretRecipient();
    let progress: (value: unknown) => void = () => {};
    let finish: (value: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    const owner = createAcpInteractionOwner({
      workspaceId: 'workspace',
      machineId: 'machine',
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      submit: async () => {},
      start: (args) => {
        signal = args.signal;
        progress = args.onProgress;
        return { result: raw, cancel: () => {} };
      },
    });
    await owner.handle(
      {
        action: 'start',
        kind: 'authenticate',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      context()
    );
    for (let n = 0; n < 100; n++)
      progress({
        status: 'runtime-download',
        runtimeName: 'x',
        runtimePhase: 'downloading',
        runtimePercent: n,
      });
    progress({ status: 'authorization', authorizationUrl: 'https://example.test' });
    progress({ status: 'input-required', interactionId: 'code' });
    expect(signal?.aborted).toBe(false);
    const poll = async (n: number, ack: number) => {
      const requestId = (n + 2).toString(16).padStart(32, '0');
      const response = await owner.handle(
        { action: 'poll', interactionRequestId: id, progressAck: ack },
        context(requestId)
      );
      return JSON.parse(
        await initiator.decrypt(
          response.responseEnvelope!,
          e2eeAcpInteractionResponseContext({ ...identity, requestId })
        )
      );
    };
    expect(await poll(0, 0)).toEqual({
      progress: {
        status: 'runtime-download',
        runtimeName: 'x',
        runtimePhase: 'downloading',
        runtimePercent: 99,
      },
      progressCursor: 1,
    });
    expect(await poll(1, 1)).toEqual({
      progress: { status: 'authorization', authorizationUrl: 'https://example.test' },
      progressCursor: 2,
    });
    expect(await poll(2, 2)).toEqual({
      progress: { status: 'input-required', interactionId: 'code' },
      progressCursor: 3,
    });
    finish({});
    await raw;
    await owner.close();
  });

  it('allows fresh ciphertext after definite decrypt failure but fences uncertain submissions', async () => {
    const initiator = await createRpcSecretRecipient();
    let finish: (value: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let attempts = 0;
    const owner = createAcpInteractionOwner({
      workspaceId: 'workspace',
      machineId: 'machine',
      createRecipient: createRpcSecretRecipient,
      encrypt: encryptRpcSecret,
      start: () => ({ result: raw, cancel: () => {} }),
      submit: async () => {
        attempts++;
        throw new Error('uncertain');
      },
    });
    const started = await owner.handle(
      {
        action: 'start',
        kind: 'authenticate',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      context()
    );
    const wrong = await encryptRpcSecret(
      started.inputPublicKey!,
      'x',
      e2eeAcpInteractionInputContext({ ...identity, interactionId: 'other' })
    );
    const request = {
      action: 'submit' as const,
      interactionRequestId: id,
      interactionId: 'code',
      inputEnvelope: wrong,
    };
    await expect(owner.handle(request, context('2'.repeat(32)))).rejects.toThrow();
    await expect(owner.handle(request, context('3'.repeat(32)))).rejects.toThrow(
      'e2ee_acp_input_replay'
    );
    const valid = await encryptRpcSecret(
      started.inputPublicKey!,
      'x',
      e2eeAcpInteractionInputContext({ ...identity, interactionId: 'code' })
    );
    await expect(
      owner.handle({ ...request, inputEnvelope: valid }, context('4'.repeat(32)))
    ).rejects.toThrow('uncertain');
    const another = await encryptRpcSecret(
      started.inputPublicKey!,
      'x',
      e2eeAcpInteractionInputContext({ ...identity, interactionId: 'code' })
    );
    await expect(
      owner.handle({ ...request, inputEnvelope: another }, context('5'.repeat(32)))
    ).rejects.toThrow('e2ee_acp_input_replay');
    expect(attempts).toBe(1);
    finish({});
    await raw;
    await owner.close();
  });

  it('fences pending decrypt and cancels immediately on revocation', async () => {
    const initiator = await createRpcSecretRecipient();
    const target = await createRpcSecretRecipient();
    const authority = new AbortController();
    let release: () => void = () => {};
    let decryptStarted: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      decryptStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: (value: unknown) => void = () => {};
    const raw = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let aborted = false;
    const inputs: string[] = [];
    const owner = createAcpInteractionOwner({
      workspaceId: 'workspace',
      machineId: 'machine',
      encrypt: encryptRpcSecret,
      createRecipient: async () => ({
        publicKey: target.publicKey,
        decrypt: async (envelope, aad) => {
          decryptStarted();
          await gate;
          return target.decrypt(envelope, aad);
        },
      }),
      start: ({ signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return { result: raw, cancel: () => {} };
      },
      submit: async ({ input }) => {
        inputs.push(input);
      },
    });
    const start = await owner.handle(
      {
        action: 'start',
        kind: 'authenticate',
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      },
      {
        ...context(),
        authority: { signal: authority.signal, isCurrent: () => !authority.signal.aborted },
      }
    );
    const envelope = await encryptRpcSecret(
      start.inputPublicKey!,
      'secret',
      e2eeAcpInteractionInputContext({ ...identity, interactionId: 'input' })
    );
    const submission = owner.handle(
      {
        action: 'submit',
        interactionRequestId: id,
        interactionId: 'input',
        inputEnvelope: envelope,
      },
      context('2'.repeat(32))
    );
    await ready;
    authority.abort();
    expect(aborted).toBe(true);
    release();
    await expect(submission).rejects.toThrow('e2ee_acp_authority_revoked');
    expect(inputs).toEqual([]);
    await expect(
      owner.handle({ action: 'poll', interactionRequestId: id }, context('3'.repeat(32)))
    ).rejects.toThrow('e2ee_acp_authority_revoked');
    finish({});
    await raw;
    await owner.close();
  });

  it('bounds shutdown while cancelling independent raw owners', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      const releases: Array<() => void> = [];
      const signals: AbortSignal[] = [];
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        closeTimeoutMs: 1000,
        createRecipient: createRpcSecretRecipient,
        encrypt: encryptRpcSecret,
        submit: async () => {},
        start: ({ signal }) => {
          signals.push(signal);
          return {
            result: new Promise((resolve) => {
              releases.push(() => resolve({}));
            }),
            cancel: () => {},
          };
        },
      });
      const request = {
        action: 'start' as const,
        kind: 'probe' as const,
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      };
      await owner.handle(request, context());
      await owner.handle(request, context('2'.repeat(32)));
      let closed = false;
      const closing = owner.close().then(() => {
        closed = true;
      });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      releases[1]?.();
      await vi.advanceTimersByTimeAsync(999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
      releases[0]?.();
      await Promise.resolve();
      await expect(owner.handle(request, context('3'.repeat(32)))).rejects.toThrow(
        'e2ee_acp_invalid_context'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an admitted operation alive after its start envelope expires', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      let finish: (value: unknown) => void = () => {};
      const raw = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      let aborted = false;
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        createRecipient: createRpcSecretRecipient,
        encrypt: encryptRpcSecret,
        submit: async () => {},
        start: ({ signal }) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return { result: raw, cancel: () => {} };
        },
      });
      await owner.handle(
        {
          action: 'start',
          kind: 'authenticate',
          configId: 'config' as never,
          responseKey: initiator.publicKey,
        },
        { ...context(), expiresAt: Date.now() + 30_000 }
      );
      await vi.advanceTimersByTimeAsync(35_000);
      expect(aborted).toBe(false);
      expect(
        (await owner.handle({ action: 'poll', interactionRequestId: id }, context('2'.repeat(32))))
          .state
      ).toBe('running');
      finish({ success: true });
      await raw;
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start work when key preparation outlives the envelope', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      const recipient = await createRpcSecretRecipient();
      let release: (value: typeof recipient) => void = () => {};
      const preparation = new Promise<typeof recipient>((resolve) => {
        release = resolve;
      });
      let started = false;
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        createRecipient: () => preparation,
        encrypt: encryptRpcSecret,
        submit: async () => {},
        start: () => {
          started = true;
          return { result: Promise.resolve({}), cancel: () => {} };
        },
      });
      const start = owner.handle(
        {
          action: 'start',
          kind: 'probe',
          configId: 'config' as never,
          responseKey: initiator.publicKey,
        },
        { ...context(), expiresAt: Date.now() + 1000 }
      );
      await vi.advanceTimersByTimeAsync(1000);
      release(recipient);
      await expect(start).rejects.toThrow('e2ee_acp_start_expired');
      expect(started).toBe(false);
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains capacity after response encryption fails until raw work settles', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      let finish: (value: unknown) => void = () => {};
      const raw = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        maxSessions: 1,
        maxLifetimeMs: 1000,
        createRecipient: createRpcSecretRecipient,
        encrypt: async () => {
          throw new Error('encryption failed');
        },
        submit: async () => {},
        start: ({ onProgress }) => {
          onProgress({ status: 'starting' });
          return { result: raw, cancel: () => {} };
        },
      });
      const request = {
        action: 'start' as const,
        kind: 'probe' as const,
        configId: 'config' as never,
        responseKey: initiator.publicKey,
      };
      await expect(owner.handle(request, context())).rejects.toThrow('encryption failed');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(owner.handle(request, context('2'.repeat(32)))).rejects.toThrow(
        'e2ee_acp_capacity'
      );
      finish({ success: true });
      await raw;
      await Promise.resolve();
      await Promise.resolve();
      // A different request can take the released slot only after raw settlement.
      await expect(owner.handle(request, context('2'.repeat(32)))).rejects.toThrow(
        'encryption failed'
      );
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels raw work at expiry and fences late completion', async () => {
    vi.useFakeTimers();
    try {
      const initiator = await createRpcSecretRecipient();
      let finish: (result: unknown) => void = () => {};
      let aborted = false;
      const raw = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const owner = createAcpInteractionOwner({
        workspaceId: 'workspace',
        machineId: 'machine',
        createRecipient: createRpcSecretRecipient,
        encrypt: encryptRpcSecret,
        maxLifetimeMs: 1000,
        start: ({ signal }) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return { result: raw, cancel: () => {} };
        },
        submit: async () => {},
      });
      await owner.handle(
        {
          action: 'start',
          kind: 'probe',
          configId: 'config' as never,
          responseKey: initiator.publicKey,
        },
        context()
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(aborted).toBe(true);
      const response = await owner.handle(
        { action: 'poll', interactionRequestId: id },
        context('2'.repeat(32))
      );
      expect(response.state).toBe('expired');
      finish({ secret: 'late' });
      await raw;
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
