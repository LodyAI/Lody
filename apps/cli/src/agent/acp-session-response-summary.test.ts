import { describe, expect, it } from 'vitest';
import type { NewSessionResponse, SessionId } from '@agentclientprotocol/sdk';
import { summarizeNewSessionResponse } from './acp-session-response-summary';

const buildResponse = (overrides: Partial<NewSessionResponse> = {}): NewSessionResponse =>
  ({
    sessionId: 'session-1' as SessionId,
    ...overrides,
  }) as NewSessionResponse;

describe('summarizeNewSessionResponse', () => {
  it('describes an agent catalog on a single line', () => {
    const summary = summarizeNewSessionResponse(
      buildResponse({
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: [
          { id: 'model', name: 'Model', type: 'select', currentValue: 'grok-4.6', options: [] },
        ],
        _meta: { isGitRepo: true },
      } as Partial<NewSessionResponse>)
    );

    expect(summary).not.toContain('\n');
    expect(summary).toContain('acpSessionId=session-1');
    expect(summary).toContain('modes=2');
    expect(summary).toContain('currentMode=default');
    expect(summary).toContain('configOptions=1');
    expect(summary).toContain('configOptionIds=model');
    expect(summary).toContain('metaKeys=isGitRepo');
  });

  it('reports the legacy model catalog by size rather than by contents', () => {
    const summary = summarizeNewSessionResponse(
      buildResponse({
        models: {
          currentModelId: 'grok-4.6',
          availableModels: Array.from({ length: 40 }, (_, index) => ({
            modelId: `model-${index}`,
            name: `Model ${index}`,
            description: 'x'.repeat(500),
          })),
        },
      } as unknown as Partial<NewSessionResponse>)
    );

    expect(summary).toContain('models=40');
    expect(summary).toContain('currentModel=grok-4.6');
    expect(summary).not.toContain('xxxx');
  });

  it('stays bounded when an agent advertises an unusually large option catalog', () => {
    const summary = summarizeNewSessionResponse(
      buildResponse({
        configOptions: Array.from({ length: 60 }, (_, index) => ({
          id: `option-${index}`,
          name: `Option ${index}`,
          type: 'boolean',
          currentValue: false,
        })),
      } as unknown as Partial<NewSessionResponse>)
    );

    expect(summary).toContain('configOptions=60');
    expect(summary).toContain('+48');
    expect(summary.length).toBeLessThan(400);
  });

  it('names the absent parts instead of dropping them', () => {
    const summary = summarizeNewSessionResponse(buildResponse());

    expect(summary).toBe(
      'acpSessionId=session-1 modes=0 currentMode=none models=0 currentModel=none configOptions=0'
    );
  });
});
