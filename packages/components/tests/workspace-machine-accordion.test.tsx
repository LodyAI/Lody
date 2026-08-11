// @vitest-environment jsdom

import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceMachineCollapsedRow,
  WorkspaceMachineExpandedSection,
  type WorkspaceMachineAccordionMeta,
} from '../src/components/settings/workspace-machine-accordion';
import { initI18n } from '../src/i18n';

const machineId = 'machine-1' as MachineId;
const meta: WorkspaceMachineAccordionMeta = {
  machine: {
    id: machineId,
    name: 'MacBook-Pro.local',
    os: 'darwin',
    cliVersion: '0.58.0',
    sessions: [],
    raceLimits: {},
  } as MachineViewMeta,
  isOnline: true,
  isLocal: true,
  isPrivate: false,
  owner: null,
  directoryCount: 4,
  agentCount: 3,
};

let container: HTMLDivElement;
let root: Root | undefined;
let nextFrameId = 1;
let frameCallbacks: Map<number, FrameRequestCallback>;

function AccordionHarness() {
  const [expanded, setExpanded] = useState(false);
  return expanded ? (
    <WorkspaceMachineExpandedSection meta={meta} onCollapse={() => setExpanded(false)}>
      <div data-machine-details>Machine details</div>
    </WorkspaceMachineExpandedSection>
  ) : (
    <WorkspaceMachineCollapsedRow meta={meta} onExpand={() => setExpanded(true)} />
  );
}

beforeEach(async () => {
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frameCallbacks = new Map();
  nextFrameId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frameCallbacks.delete(id));
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe('WorkspaceMachineExpandedSection', () => {
  it('commits the expanded row before mounting detail and preserves the row layout', () => {
    flushSync(() => root?.render(<AccordionHarness />));

    const collapsedRow = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]'
    );
    expect(collapsedRow).not.toBeNull();
    const rowClassName = collapsedRow!.className;
    const childLayout = [...collapsedRow!.children].map(
      (child) => `${child.tagName}:${child.className}`
    );

    flushSync(() => collapsedRow!.click());

    const expandedRow = container.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    expect(expandedRow).not.toBeNull();
    expect(expandedRow!.className).toBe(rowClassName);
    const expandedChildLayout = [...expandedRow!.children].map(
      (child) => `${child.tagName}:${child.className}`
    );
    expect(expandedChildLayout.slice(0, -1)).toEqual(childLayout.slice(0, -1));
    expect(expandedRow!.lastElementChild?.tagName).toBe(collapsedRow!.lastElementChild?.tagName);
    expect(expandedRow!.lastElementChild?.classList.contains('h-4')).toBe(true);
    expect(expandedRow!.lastElementChild?.classList.contains('w-4')).toBe(true);
    expect(expandedRow!.lastElementChild?.classList.contains('shrink-0')).toBe(true);
    expect(container.querySelector('[data-machine-details]')).toBeNull();
    expect(frameCallbacks.size).toBe(1);

    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    flushSync(() => callbacks[0]!(performance.now()));

    expect(container.querySelector('[data-machine-details]')).toBeNull();
    expect(frameCallbacks.size).toBe(1);

    const detailCallbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    flushSync(() => detailCallbacks[0]!(performance.now()));

    expect(container.querySelector('[data-machine-details]')?.textContent).toBe('Machine details');
  });
});
