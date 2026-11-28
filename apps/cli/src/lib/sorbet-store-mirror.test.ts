/**
 * The daemon side of the Sorbet mirror: what one read of the machine's store
 * puts into its Flock, and the three moments that read happens.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import {
  createSorbetStoreMirror,
  SORBET_STORE_MIRROR_INTERVAL_MS,
  startSorbetStoreMirrorLoop,
} from './sorbet-store-mirror';

const openSorbetControl = vi.hoisted(() => vi.fn());
vi.mock('@sorbetai/control', () => ({ openSorbetControl }));

const machineId = 'machine' as MachineId;

function control(overrides: Record<string, unknown> = {}) {
  return {
    credentials: {
      list: vi.fn(async () => [{ providerId: 'anthropic', type: 'oauth' }]),
    },
    providers: {
      listCustom: vi.fn(async () => [
        {
          id: 'gateway',
          name: 'Acme Gateway',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          models: [{ id: 'meridian', name: 'Meridian', reasoning: true, contextWindow: 200_000 }],
          catalogRefs: ['meridian'],
        },
      ]),
      availableModels: vi.fn(async () => [
        {
          selector: 'gateway/meridian',
          providerId: 'gateway',
          modelId: 'meridian',
          displayName: 'Meridian',
        },
      ]),
    },
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('Sorbet store mirror', () => {
  let dataDirectory: string;

  beforeEach(async () => {
    openSorbetControl.mockReset();
    dataDirectory = await mkdtemp(join(tmpdir(), 'sorbet-mirror-'));
  });

  afterEach(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it('publishes every family from one read and closes the handle', async () => {
    const instance = control();
    openSorbetControl.mockResolvedValueOnce(instance);
    const document = { writeSorbetStoreMirror: vi.fn(async () => true) };

    const mirror = createSorbetStoreMirror({ document, machineId, dataDirectory });
    await expect(mirror()).resolves.toBe(true);

    expect(openSorbetControl).toHaveBeenCalledOnce();
    expect(instance.close).toHaveBeenCalledOnce();
    expect(document.writeSorbetStoreMirror).toHaveBeenCalledWith(machineId, {
      credentials: [{ providerId: 'anthropic', type: 'oauth' }],
      providers: [
        {
          id: 'gateway',
          name: 'Acme Gateway',
          protocol: 'openai-completions',
          baseUrl: 'https://gateway.example.com/v1',
          models: [{ id: 'meridian', name: 'Meridian' }],
        },
      ],
      models: [
        {
          selector: 'gateway/meridian',
          providerId: 'gateway',
          modelId: 'meridian',
          displayName: 'Meridian',
        },
      ],
    });
  });

  it('leaves a machine that never ran Sorbet alone instead of creating its store', async () => {
    const document = { writeSorbetStoreMirror: vi.fn(async () => true) };

    const mirror = createSorbetStoreMirror({
      document,
      machineId,
      dataDirectory: join(dataDirectory, 'never-created'),
    });
    await expect(mirror()).resolves.toBe(false);

    expect(openSorbetControl).not.toHaveBeenCalled();
    expect(document.writeSorbetStoreMirror).not.toHaveBeenCalled();
  });

  it('keeps the last published rows when the store cannot be read', async () => {
    const failure = new Error('store is locked');
    openSorbetControl.mockRejectedValueOnce(failure);
    const document = { writeSorbetStoreMirror: vi.fn(async () => true) };
    const logger = { warn: vi.fn(), debug: vi.fn() };

    const mirror = createSorbetStoreMirror({ document, machineId, dataDirectory, logger });
    await expect(mirror()).resolves.toBe(false);

    expect(document.writeSorbetStoreMirror).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('store is locked'));
  });

  it('runs once at start, again every interval, and stops on demand', async () => {
    vi.useFakeTimers();
    try {
      const document = { writeSorbetStoreMirror: vi.fn(async () => true) };
      openSorbetControl.mockImplementation(async () => control());
      const loop = startSorbetStoreMirrorLoop({
        document,
        machineId,
        dataDirectory,
        logger: { warn: vi.fn(), debug: vi.fn() },
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.writeSorbetStoreMirror).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SORBET_STORE_MIRROR_INTERVAL_MS);
      expect(document.writeSorbetStoreMirror).toHaveBeenCalledTimes(2);

      loop.stop();
      await vi.advanceTimersByTimeAsync(SORBET_STORE_MIRROR_INTERVAL_MS * 3);
      expect(document.writeSorbetStoreMirror).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one read between callers that ask at the same time', async () => {
    const document = { writeSorbetStoreMirror: vi.fn(async () => true) };
    openSorbetControl.mockImplementation(async () => control());
    const loop = startSorbetStoreMirrorLoop({ document, machineId, dataDirectory });

    await Promise.all([loop.refresh(), loop.refresh(), loop.refresh()]);

    expect(openSorbetControl).toHaveBeenCalledOnce();
    expect(document.writeSorbetStoreMirror).toHaveBeenCalledOnce();
    loop.stop();
  });
});
