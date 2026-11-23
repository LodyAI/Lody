import { describe, expect, it } from 'vitest';

import { classifyPermissionModeFace } from '../src/ai';

describe('classifyPermissionModeFace', () => {
  it('hides the normal/default working mode of each built-in agent', () => {
    expect(classifyPermissionModeFace('agent')).toEqual({ kind: 'hidden' }); // Codex plain working mode
    expect(classifyPermissionModeFace('default')).toEqual({ kind: 'hidden' }); // Claude default
  });

  it('hides unknown / third-party modes so long names never hit the button face', () => {
    expect(classifyPermissionModeFace('some-vendor-super-long-mode-name')).toEqual({
      kind: 'hidden',
    });
    expect(classifyPermissionModeFace(null)).toEqual({ kind: 'hidden' });
    expect(classifyPermissionModeFace(undefined)).toEqual({ kind: 'hidden' });
  });

  it('flags safety-model-changing modes as warnings', () => {
    // Codex full access — loosens what the agent may touch.
    expect(classifyPermissionModeFace('agent-full-access')).toEqual({
      kind: 'full-access',
      tone: 'warning',
      render: 'icon',
    });
    expect(classifyPermissionModeFace('danger-full-access')).toEqual({
      kind: 'full-access',
      tone: 'warning',
      render: 'icon',
    });
    // Claude "Don't Ask" — skips the human approval prompt.
    expect(classifyPermissionModeFace('dontAsk')).toEqual({
      kind: 'deny',
      tone: 'warning',
      render: 'icon',
    });
    expect(classifyPermissionModeFace('bypassPermissions')).toEqual({
      kind: 'full-access',
      tone: 'warning',
      render: 'icon',
    });
  });

  it('renders model-reviewed approval modes as a short text label, neutral tone', () => {
    // Claude auto and Codex auto review both route approval prompts to a model.
    for (const modeId of ['auto', 'agent-auto-review']) {
      expect(classifyPermissionModeFace(modeId)).toEqual({
        kind: 'auto',
        tone: 'neutral',
        render: 'auto-label',
      });
    }
  });

  it('classifies restrictive / edit modes as neutral icons', () => {
    expect(classifyPermissionModeFace('read-only')).toMatchObject({
      tone: 'neutral',
      render: 'icon',
    });
    expect(classifyPermissionModeFace('acceptEdits')).toMatchObject({
      tone: 'neutral',
      render: 'icon',
    });
    expect(classifyPermissionModeFace('plan')).toMatchObject({ tone: 'neutral', render: 'icon' });
  });
});
