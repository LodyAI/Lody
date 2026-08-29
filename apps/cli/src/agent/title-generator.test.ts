import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, AcpSessionNotification } from '@lody/shared';

import {
  applyResolvedTitleConfigOptions,
  applyTitleConfigOptions,
  extractTitleChunkFromNotification,
  resolveTitleConfigOptionValues,
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

describe('applyResolvedTitleConfigOptions', () => {
  it('uses automatic reasoning when an explicit value is stale after a model switch', async () => {
    const initialConfigOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: 'model-a',
        options: [
          { value: 'model-a', name: 'Model A' },
          { value: 'model-b', name: 'Model B' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'ultra', name: 'Ultra' },
        ],
      },
    ];
    const modelBConfigOptions = [
      { ...initialConfigOptions[0], currentValue: 'model-b' },
      {
        ...initialConfigOptions[1],
        options: [
          { value: 'none', name: 'None' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
        ],
      },
    ];
    const setSessionConfigOption = vi.fn(async () => modelBConfigOptions);

    await applyResolvedTitleConfigOptions({
      client: {
        setSessionConfigOption,
        unstable_setSessionModel: vi.fn(async () => {}),
      } as never,
      acpSessionId: 'title-session' as ACPSessionId,
      cliType: 'builtin',
      agentType: 'codex',
      sessionResponse: { configOptions: initialConfigOptions },
      configuredValues: { model: 'model-b', reasoning_effort: 'ultra' },
      logger: { debug: vi.fn() } as never,
    });

    expect(setSessionConfigOption.mock.calls).toEqual([
      ['title-session', 'model', 'model-b'],
      ['title-session', 'reasoning_effort', 'none'],
    ]);
  });
});

describe('resolveTitleConfigOptionValues', () => {
  const configOptions = [
    {
      id: 'amp-mode',
      name: 'Amp mode',
      category: 'model',
      type: 'select' as const,
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'ultra', name: 'Ultra' },
      ],
    },
    {
      id: 'permission',
      name: 'Permission',
      category: 'mode',
      type: 'select' as const,
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'read-only', name: 'Read Only' },
      ],
    },
  ];

  it('keeps the provider model and applies only recognized automatic overrides', () => {
    expect(resolveTitleConfigOptionValues('registry', 'amp-acp', configOptions)).toEqual({
      permission: 'read-only',
    });
  });

  it('merges sparse explicit values over automatic overrides', () => {
    expect(
      resolveTitleConfigOptionValues('registry', 'amp-acp', configOptions, {
        'amp-mode': 'ultra',
        permission: 'default',
      })
    ).toEqual({
      'amp-mode': 'ultra',
      permission: 'default',
    });
  });

  it('keeps an automatic safe value when its explicit override is unavailable', () => {
    expect(
      resolveTitleConfigOptionValues('registry', 'amp-acp', configOptions, {
        permission: 'legacy-read-only',
        removed_option: 'legacy-value',
      })
    ).toEqual({
      permission: 'read-only',
      removed_option: 'legacy-value',
    });
  });
});
