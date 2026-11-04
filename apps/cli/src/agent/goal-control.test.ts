import { describe, expect, it } from 'vitest';
import type { LodyGoalCapability } from 'acp-extension-core';
import { resolveGoalActionTransport } from './goal-control';

const capability = (overrides: Partial<LodyGoalCapability> = {}): LodyGoalCapability => ({
  version: 1,
  actions: ['set', 'pause', 'resume', 'clear'],
  ...overrides,
});

describe('resolveGoalActionTransport', () => {
  it('keeps work-starting actions inside a prompt even when the request lists them', () => {
    // An agent that starts the goal's work from a bare request would produce
    // turns Lody never prompted for and cannot attribute to a conversation.
    const advertised = capability({
      controlActions: ['set', 'pause', 'resume', 'clear'],
      promptActions: ['set', 'resume'],
    });

    expect(resolveGoalActionTransport(advertised, 'resume')).toBe('promptMeta');
    expect(resolveGoalActionTransport(advertised, 'set')).toBe('promptMeta');
  });

  it('falls back to the slash bridge for runtimes that advertise no transports', () => {
    const legacy = capability();

    expect(resolveGoalActionTransport(legacy, 'pause')).toBe('slashCommand');
    expect(resolveGoalActionTransport(legacy, 'resume')).toBe('slashCommand');
  });

  it('refuses actions the agent never advertised', () => {
    expect(resolveGoalActionTransport(undefined, 'pause')).toBeNull();
    expect(
      resolveGoalActionTransport(capability({ controlActions: ['pause'] }), 'pause', 'prompt')
    ).toBeNull();
    expect(resolveGoalActionTransport(capability({ actions: ['set'] }), 'resume')).toBeNull();
    expect(
      resolveGoalActionTransport(
        capability({ controlActions: ['pause'], promptActions: ['set'] }),
        'resume'
      )
    ).toBeNull();
  });
});
