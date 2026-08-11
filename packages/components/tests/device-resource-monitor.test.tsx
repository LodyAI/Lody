// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentConfigId,
  AgentConfigMeta,
  MachineId,
  MachineMonitorSnapshot,
  SessionId,
  SessionMeta,
} from '@lody/shared';
import { DeviceResourceMonitor } from '../src/components/settings/device-resource-monitor';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

const machineId = 'machine-test' as MachineId;

const resource = {
  memoryBytes: 256 * 1024 * 1024,
  cpuCores: 0.5,
  cpuPercentOfMachine: 5,
  processCount: 2,
  memoryKind: 'rss' as const,
  quality: 'exact-process' as const,
};

const snapshot: MachineMonitorSnapshot = {
  kind: 'snapshot',
  protocolVersion: 1,
  machineId,
  instanceId: 'cli-test',
  updatedAtMs: Date.now(),
  sampleWindowMs: 2_000,
  platform: 'darwin',
  cpuLogicalCores: 8,
  deviceCpuCores: 1,
  effectiveMemoryBytes: 16 * 1024 * 1024 * 1024,
  availableMemoryBytes: 8 * 1024 * 1024 * 1024,
  sessionAccounting: 'process-tree',
  cliControlPlane: { ...resource, processCount: 1 },
  sessionsAggregate: resource,
  sessions: [
    {
      sessionId: 'session-running' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'codex',
      status: 'running',
      lastActivityAtMs: Date.now(),
      startedAtMs: Date.now() - 60_000,
      resource,
    },
    {
      sessionId: 'session-permission' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'claude',
      status: 'waiting_permission',
      lastActivityAtMs: Date.now() - 5_000,
      startedAtMs: Date.now() - 120_000,
      resource,
    },
    {
      sessionId: 'session-idle' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'codex',
      status: 'idle',
      lastActivityAtMs: Date.now() - 30_000,
      startedAtMs: Date.now() - 300_000,
      resource,
    },
  ],
  sessionsTruncated: false,
  warnings: [],
};

const agentConfigs: AgentConfigMeta[] = [
  {
    id: 'config-codex' as AgentConfigId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

const sessionMetas: SessionMeta[] = snapshot.sessions.map((session) => ({
  id: session.sessionId,
  machineId,
  createdAt: new Date().toISOString(),
  title: `Title for ${session.status}`,
  userId: 'user-test',
  cliType: 'builtin',
  agentType: 'codex',
  agentConfigId: 'config-codex' as AgentConfigId,
}));

const mobileStatusRows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[class*="md:hidden"]')).filter(
    (element) => element.className.includes('col-span-2')
  );

describe('DeviceResourceMonitor session status presentation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <DeviceResourceMonitor
            snapshot={snapshot}
            state="active"
            sessionMetas={sessionMetas}
            agentConfigs={agentConfigs}
            onOpenSession={vi.fn()}
            onTerminateSession={vi.fn(async () => {})}
          />
        </TooltipProvider>
      );
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps the status name visible as text in the touch/mobile row', () => {
    const rows = mobileStatusRows();
    expect(rows).toHaveLength(3);
    const texts = rows.map((row) => row.textContent ?? '');
    expect(texts[0]).toContain('Running');
    expect(texts[1]).toContain('Waiting for permission');
    expect(texts[2]).toContain('Idle');
  });

  it('makes the desktop tooltip trigger keyboard focusable with an accessible name', () => {
    const triggers = Array.from(
      document.body.querySelectorAll<HTMLElement>('span[role="img"][tabindex="0"]')
    );
    expect(triggers).toHaveLength(3);
    expect(triggers.map((trigger) => trigger.getAttribute('aria-label'))).toEqual([
      'Running',
      'Waiting for permission',
      'Idle',
    ]);
  });

  it('opens the status tooltip on keyboard focus', async () => {
    const trigger = document.body.querySelector<HTMLElement>(
      'span[role="img"][aria-label="Waiting for permission"]'
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.focus();
    });
    await vi.waitFor(() => {
      const tooltip = document.body.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toContain('Waiting for permission');
    });
  });

  it('keeps the resource cards and omits the empty ACP session message', async () => {
    await act(async () => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <DeviceResourceMonitor
            snapshot={{ ...snapshot, sessions: [] }}
            state="active"
            agentConfigs={agentConfigs}
          />
        </TooltipProvider>
      );
    });

    expect(container?.textContent).toContain('CLI');
    expect(container?.textContent).not.toContain('No resident ACP sessions');
  });
});
