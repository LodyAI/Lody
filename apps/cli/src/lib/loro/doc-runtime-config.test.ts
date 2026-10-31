import { updateTestHistory } from '../../../tests/history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const historyEntry = (id: string, role: 'user' | 'assistant') => ({
  id,
  timestamp: '2026-08-29T00:00:00.000Z',
  role,
  fileDiff: [],
});

const createDocument = (flush = async () => {}) => {
  const doc = new SessionDocument(
    { flush } as LoroRepo,
    'session-runtime-config' as SessionId,
    async () => {},
    {
      debug: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger
  );
  // Compose the production storage entry and seed the initial user turn
  // through the shared writer, matching how `init()` sees a persisted doc.
  composeTestSessionDoc(doc, { history: [historyEntry('turn-1', 'user')] });
  return doc;
};

describe('SessionDocument ACP runtime config', () => {
  const connection = {
    acpSessionId: 'acp-1' as never,
    generation: 'connection-1',
    state: 'ready' as const,
  };

  it('requires the current revision to finish local persistence before it can be used', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const doc = createDocument(() => held);
    await doc.beginAcpRuntimeConfig('', { ...connection, modeId: 'default' });
    const flush = doc.flushLocalWrites();
    expect(doc.isAcpConfigurationConfirmed(connection.generation)).toBe(false);
    await expect(
      doc.acceptWithConfigRevision({ configRevision: 1 }, async () => 'unexpected')
    ).rejects.toThrow('SESSION_CONFIG_UNCONFIRMED');
    await doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'plan' });
    release();
    await flush;
    expect(doc.isAcpConfigurationConfirmed(connection.generation)).toBe(false);
    await doc.flushLocalWrites();
    expect(doc.isAcpConfigurationConfirmed(connection.generation)).toBe(true);
    await expect(
      doc.acceptWithConfigRevision({ configRevision: 2 }, async () => 'accepted')
    ).resolves.toBe('accepted');
  });

  it('keeps confirmed changes independently of newer history and queue inputs', async () => {
    const doc = createDocument();
    await doc.beginAcpRuntimeConfig('turn-1', {
      ...connection,
      modeId: 'plan',
      configOptionValues: { plan: true },
    });
    await updateTestHistory(doc, (history) => [...history, historyEntry('turn-2', 'user')]);
    await doc.applyAcpRuntimeConfigPatch('turn-1', {
      ...connection,
      modeId: 'default',
      configOptionValues: { plan: false },
    });
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      modeId: 'default',
      configOptionValues: { plan: false },
      revision: 2,
    });
    expect(
      await doc.applyAcpRuntimeConfigPatch('turn-1', {
        ...connection,
        modeId: 'default',
        configOptionValues: { plan: false },
      })
    ).toBe(false);
  });

  it('requires owner attachment and fences old connections even when ACP reuses its session id', async () => {
    const doc = createDocument();
    expect(await doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'plan' })).toBe(false);
    await doc.beginAcpRuntimeConfig('', {
      ...connection,
      modeId: 'plan',
      availableCommands: [{ name: 'old' }],
    });
    const staleWrite = doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'plan' });
    await doc.beginAcpRuntimeConfig('', {
      ...connection,
      generation: 'connection-2',
      modeId: 'default',
    });
    expect(await staleWrite).toBe(false);
    expect(await doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'plan' })).toBe(false);
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      generation: 'connection-2',
      modeId: 'default',
      revision: 2,
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toBeUndefined();
  });

  it('merges partial updates but replaces the whole option table, preserving false', async () => {
    const doc = createDocument();
    await doc.beginAcpRuntimeConfig('', {
      ...connection,
      modeId: 'default',
      configOptionValues: { plan: true, effort: 'high' },
      availableCommands: [{ name: 'review' }],
    });
    await doc.applyAcpRuntimeConfigPatch('', {
      ...connection,
      configOptionValues: { plan: false },
      state: 'applying',
    });
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      modeId: 'default',
      state: 'applying',
      configOptionValues: { plan: false },
      availableCommands: [{ name: 'review' }],
    });
    await doc.applyAcpRuntimeConfigPatch('', {
      ...connection,
      availableCommands: [],
      state: 'failed',
      error: { code: 'REJECTED', message: 'Configuration rejected' },
    });
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      state: 'failed',
      configOptionValues: { plan: false },
      availableCommands: [],
      error: { code: 'REJECTED' },
    });
  });

  it('orders first acceptance before a competing config publication and ignores retired connections', async () => {
    const doc = createDocument();
    await doc.beginAcpRuntimeConfig('', { ...connection, modeId: 'default' });
    let release: (() => void) | undefined;
    await doc.flushLocalWrites();
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accept = doc.acceptWithConfigRevision({ configRevision: 1 }, async () => {
      started?.();
      await commit;
      return 'accepted';
    });
    await entered;
    const update = doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'plan' });
    expect(doc.mirror?.getState().acpRuntimeConfig?.modeId).toBe('default');
    release?.();
    expect(await accept).toBe('accepted');
    await update;
    await doc.flushLocalWrites();
    await expect(
      doc.acceptWithConfigRevision({ configRevision: 1 }, async () => 'unexpected')
    ).rejects.toThrow('SESSION_CONFIG_CHANGED');
    await doc.retireAcpRuntimeConfig(connection.generation);
    expect(await doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'default' })).toBe(
      false
    );
    expect(doc.mirror?.getState().acpRuntimeConfig?.state).toBe('unknown');
  });

  it('checks the durable acceptance receipt inside the publication queue for duplicate first claims', async () => {
    const doc = createDocument();
    await doc.beginAcpRuntimeConfig('', { ...connection, modeId: 'plan' });
    await doc.flushLocalWrites();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let receipt = false;
    const first = doc.acceptWithConfigRevision(
      { configRevision: 1 },
      async () => {
        entered.resolve();
        await release.promise;
        receipt = true;
        return 'first';
      },
      () => receipt
    );
    await entered.promise;
    const update = doc.applyAcpRuntimeConfigPatch('', { ...connection, modeId: 'default' });
    const duplicate = doc.acceptWithConfigRevision(
      { configRevision: 1 },
      async () => 'duplicate',
      () => receipt
    );
    release.resolve();
    expect(await first).toBe('first');
    await update;
    expect(await duplicate).toBe('duplicate');
    await doc.flushLocalWrites();
    await expect(
      doc.acceptWithConfigRevision(
        { configRevision: 1 },
        async () => 'new',
        () => false
      )
    ).rejects.toThrow('SESSION_CONFIG_CHANGED');
  });

  it('does not accept persisted confirmation until a live generation attaches after restart', async () => {
    const doc = createDocument();
    doc.mirror?.setState((state) => {
      state.acpRuntimeConfig = {
        ...connection,
        revision: 4,
        basedOnUserTurnId: 'old',
        modeId: 'plan',
      };
      return state;
    });
    await expect(
      doc.acceptWithConfigRevision({ configRevision: 4 }, async () => 'accepted')
    ).rejects.toThrow('SESSION_CONFIG_UNCONFIRMED');
    await doc.invalidateStoredAcpRuntimeConfig();
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      state: 'unknown',
      modeId: 'plan',
      revision: 5,
    });
    await doc.beginAcpRuntimeConfig('', {
      ...connection,
      generation: 'connection-2',
      modeId: 'default',
    });
    await doc.flushLocalWrites();
    expect(doc.isAcpConfigurationConfirmed('connection-2')).toBe(true);
    await doc.invalidateStoredAcpRuntimeConfig();
    expect(doc.mirror?.getState().acpRuntimeConfig?.state).toBe('ready');
  });

  it('never publishes sensitive values through begin or subsequent updates', async () => {
    const doc = createDocument();
    await doc.beginAcpRuntimeConfig('', {
      ...connection,
      configOptionValues: { api_token: 'secret', effort: 'high' },
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.configOptionValues).toEqual({ effort: 'high' });
    await doc.applyAcpRuntimeConfigPatch('', {
      ...connection,
      configOptionValues: { credential: 'secret', plan: false },
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.configOptionValues).toEqual({ plan: false });
  });
});
