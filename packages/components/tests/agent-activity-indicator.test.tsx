// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AgentActivityIndicator } from '../src/components/shared/agent-activity-indicator';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = undefined;
  container.remove();
});

function render(node: React.ReactElement) {
  flushSync(() => root?.render(node));
}

describe('AgentActivityIndicator', () => {
  it('uses CSS animation surfaces without a canvas or per-character DOM', () => {
    render(<AgentActivityIndicator label="Thinking" tone="primary" displaySize={14} />);

    expect(container.querySelector('canvas')).toBeNull();

    const dot = container.querySelector<HTMLElement>('.agent-activity-dot');
    const pulse = container.querySelector<HTMLElement>('.agent-activity-dot-pulse');
    const label = container.querySelector<HTMLElement>('.agent-activity-label');

    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.style.width).toBe('14px');
    expect(dot?.style.height).toBe('14px');
    expect(dot?.style.getPropertyValue('--agent-activity-color')).toBe(
      'hsl(var(--primary, 199 89% 72%))'
    );
    expect(pulse?.childElementCount).toBe(0);
    expect(label?.textContent).toBe('Thinking');
    expect(label?.childElementCount).toBe(0);
    expect(label?.dataset.highlightLabel).toBe('Thinking');
    expect(label?.style.getPropertyValue('--agent-activity-label-duration')).toBe('2780ms');
  });

  it('maps custom animation timing and color to CSS variables', () => {
    render(
      <AgentActivityIndicator
        color="#a78bfa"
        label="Work"
        labelHighlightCount={2}
        labelHighlightIntervalMs={100}
        labelHighlightPauseMs={500}
      />
    );

    const dot = container.querySelector<HTMLElement>('.agent-activity-dot');
    const label = container.querySelector<HTMLElement>('.agent-activity-label');

    expect(dot?.style.getPropertyValue('--agent-activity-color')).toBe('#a78bfa');
    expect(label?.style.getPropertyValue('--agent-activity-label-duration')).toBe('1100ms');
  });
});
