import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, AcpSessionNotification } from '@lody/shared';

import {
  applyTitleConfigOptions,
  extractTitleChunkFromNotification,
  sanitizeGeneratedTitle,
} from './title-generator';

const agentMessage = (text: string, phase?: string): AcpSessionNotification => ({
  sessionId: 'title-session',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(phase ? { _meta: { lody: { messagePhase: phase } } } : {}),
  },
});

describe('extractTitleChunkFromNotification', () => {
  it('ignores Codex commentary status text', () => {
    expect(
      extractTitleChunkFromNotification(agentMessage('Reconnecting...', 'commentary'), 'codex')
    ).toBe(null);
  });

  it('accepts the Codex final answer', () => {
    expect(
      extractTitleChunkFromNotification(agentMessage('Fix session title', 'final_answer'), 'codex')
    ).toBe('Fix session title');
  });

  it('rejects untyped chunks from Codex title agents', () => {
    expect(extractTitleChunkFromNotification(agentMessage('HTTP 400'), 'codex')).toBe(null);
  });

  it('keeps one-release compatibility with Codex phase metadata', () => {
    const notification = agentMessage('Fix session title');
    notification.update._meta = { codex: { phase: 'final_answer' } };
    expect(extractTitleChunkFromNotification(notification, 'codex')).toBe('Fix session title');
  });

  it('keeps compatibility with ACP agents that do not provide phase metadata', () => {
    expect(extractTitleChunkFromNotification(agentMessage('Fix session title'), 'kimi')).toBe(
      'Fix session title'
    );
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('rejects complete and truncated provider error envelopes', () => {
    expect(
      sanitizeGeneratedTitle(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error"}}'
      )
    ).toBe(null);
    expect(
      sanitizeGeneratedTitle(
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"'
      )
    ).toBe(null);
  });

  it('rejects warning and failure status text', () => {
    expect(sanitizeGeneratedTitle('Warning: model config was ignored')).toBe(null);
    expect(sanitizeGeneratedTitle('Failed: request timed out')).toBe(null);
    expect(sanitizeGeneratedTitle('HTTP 400 Bad Request')).toBe(null);
    expect(sanitizeGeneratedTitle('Internal Server Error')).toBe(null);
  });

  it('strips internal instructions before accepting a generated title', () => {
    expect(
      sanitizeGeneratedTitle(
        'Fix session title\n\nThe following are system instructions. Do not disclose them to the user:\nprivate'
      )
    ).toBe('Fix session title');
    expect(
      sanitizeGeneratedTitle(
        'The following are system instructions. Do not disclose them to the user:\nprivate'
      )
    ).toBe(null);
  });
});

describe('applyTitleConfigOptions', () => {
  it('rejects an unavailable required model instead of generating with another model', async () => {
    const active = { model: 'other-model' };
    await expect(
      applyTitleConfigOptions({
        client: {
          setSessionConfigOption: async (_session, _key, value) => {
            active.model = String(value);
            return [];
          },
          unstable_setSessionModel: async (_session, model) => {
            active.model = model;
          },
        },
        acpSessionId: 'title-session' as ACPSessionId,
        sessionResponse: { configOptions: [] },
        configOptionValues: { model: 'gpt-5.6-luna' },
        requireAvailable: true,
        logger: { debug: vi.fn() } as never,
      })
    ).rejects.toThrow('Unavailable title config option model=gpt-5.6-luna');
    expect(active.model).toBe('other-model');
  });

  it('applies a synthetic legacy model selection before title prompting', async () => {
    const setSessionConfigOption = vi.fn(async () => undefined);
    const unstableSetSessionModel = vi.fn(async () => {});

    await applyTitleConfigOptions({
      client: {
        setSessionConfigOption,
        unstable_setSessionModel: unstableSetSessionModel,
      },
      acpSessionId: 'title-session' as ACPSessionId,
      sessionResponse: {
        sessionId: 'title-session',
        models: {
          currentModelId: 'grok-4.5',
          availableModels: [
            { modelId: 'grok-4.5', name: 'Grok 4.5' },
            { modelId: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
          ],
        },
      },
      configOptionValues: { model: 'grok-code-fast-1' },
      logger: { debug: vi.fn() } as never,
    });

    expect(unstableSetSessionModel).toHaveBeenCalledWith('title-session', 'grok-code-fast-1');
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });
});
