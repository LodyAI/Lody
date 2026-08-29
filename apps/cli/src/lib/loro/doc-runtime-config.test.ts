import { describe, expect, it, vi } from 'vitest';
import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema, type SessionId } from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';

const historyEntry = (id: string, role: 'user' | 'assistant') => ({
  id,
  timestamp: '2026-08-29T00:00:00.000Z',
  role,
  fileDiff: [],
});

const createDocument = () => {
  const doc = new SessionDocument(
    {} as LoroRepo,
    'session-runtime-config' as SessionId,
    async () => {},
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger
  );
  doc.mirror = new Mirror({
    doc: new Loro(),
    schema: sessionDocSchema,
    initialState: {
      session: { id: doc.sessionId },
      history: [],
    },
  });
  doc.mirror.setState((state) => {
    state.history.push(historyEntry('turn-1', 'user'));
    return state;
  });
  return doc;
};

describe('SessionDocument ACP runtime config', () => {
  it('merges same-turn patches and makes replay idempotent', () => {
    const doc = createDocument();

    expect(
      doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        configOptionValues: { collaboration_mode: 'default' },
      })
    ).toBe(true);
    expect(
      doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        modelId: 'gpt-5.6-sol',
      })
    ).toBe(true);
    expect(
      doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        modelId: 'gpt-5.6-sol',
      })
    ).toBe(false);

    expect(doc.mirror?.getState().acpRuntimeConfig).toEqual({
      acpSessionId: 'acp-1',
      basedOnUserTurnId: 'turn-1',
      revision: 2,
      modelId: 'gpt-5.6-sol',
      configOptionValues: { collaboration_mode: 'default' },
    });
  });

  it('rejects missing and stale turns, then starts a clean snapshot for the latest turn', () => {
    const doc = createDocument();
    expect(
      doc.applyAcpRuntimeConfigPatch('missing', {
        acpSessionId: 'acp-1' as never,
        modeId: 'plan',
      })
    ).toBe(false);
    expect(
      doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        modeId: 'plan',
        configOptionValues: { collaboration_mode: 'plan' },
      })
    ).toBe(true);

    doc.mirror?.setState((state) => ({
      ...state,
      history: [
        ...state.history,
        historyEntry('assistant-1', 'assistant'),
        historyEntry('turn-2', 'user'),
      ],
    }));

    expect(
      doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        modeId: 'default',
      })
    ).toBe(false);
    expect(
      doc.applyAcpRuntimeConfigPatch('turn-2', {
        acpSessionId: 'acp-2' as never,
        modeId: 'default',
      })
    ).toBe(true);
    expect(doc.mirror?.getState().acpRuntimeConfig).toEqual({
      acpSessionId: 'acp-2',
      basedOnUserTurnId: 'turn-2',
      revision: 2,
      modeId: 'default',
    });
  });
});
