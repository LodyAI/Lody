// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { AiUsageSettingsView } from '../src/components/settings/ai-usage-setting-view';
import type { AiUsageQuotaRow } from '../src/components/settings/ai-usage-model';

const quotaRows: AiUsageQuotaRow[] = [
  {
    id: 'm1:claude',
    configId: 'claude-work' as AiUsageQuotaRow['configId'],
    machineId: 'm1' as AiUsageQuotaRow['machineId'],
    providerKey: 'claude',
    providerName: 'Claude Code',
    machineName: 'MacBook Pro',
    machineOnline: true,
    windows: [
      {
        usedPercent: 38,
        remainingPercent: 62,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: null,
      },
    ],
    wallet: null,
    supportsQuery: true,
  },
  {
    id: 'm2:kimi',
    configId: 'kimi-code' as AiUsageQuotaRow['configId'],
    machineId: 'm2' as AiUsageQuotaRow['machineId'],
    providerKey: 'kimi',
    providerName: 'Kimi Code',
    machineName: 'Mac mini',
    machineOnline: false,
    windows: [],
    wallet: null,
    supportsQuery: false,
  },
];

describe('AiUsageSettingsView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders live quota, history, usage, attribution, and waiting sections', async () => {
    await act(async () => {
      root.render(
        <AiUsageSettingsView
          quotaRows={quotaRows}
          quotaLoading={false}
          onRefreshQuota={() => undefined}
          usageTotals={null}
          usageBuckets={[]}
          byModelBuckets={[
            {
              label: 'Mon',
              values: [{ id: 'claude-opus', label: 'claude-opus', value: 1000 }],
            },
          ]}
          byMemberBuckets={[
            {
              label: 'Mon',
              values: [{ id: 'alice', label: 'Alice', value: 1000 }],
            },
          ]}
          usageLoading={false}
          providerRows={[
            {
              key: 'claude',
              label: 'Claude',
              machines: ['MacBook Pro'],
              tokens: 1000,
              costUSD: 0.1,
              share: 100,
              quotaPercent: 62,
            },
          ]}
          historyPanels={[
            {
              id: '5h',
              title: '5 hours',
              rangeLabel: 'Last 24 hours',
              labels: ['00:00', '24:00'],
              series: [
                {
                  id: 'claude',
                  label: 'Claude',
                  color: '#2563eb',
                  points: [
                    { x: 0, y: 80 },
                    { x: 1, y: 62 },
                  ],
                },
              ],
            },
          ]}
          waitingRows={[
            {
              id: 'session-1',
              title: 'Fix auth token refresh',
              providerLabel: 'Claude Opus 4.5',
              machineName: 'MacBook Pro',
              state: 'scheduled',
              nextActionLabel: '18',
              elapsedLabel: 'Waited 6 minutes',
            },
          ]}
        />
      );
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Live quota');
    expect(text).toContain('Claude Code');
    expect(text).toContain('62%');
    expect(text).toContain('Not reported');
    expect(text).toContain('Quota history');
    expect(text).toContain('Provider and machine');
    expect(text).toContain('Breakdown');
    expect(text).toContain('By model');
    expect(text).toContain('Waiting to resume');
    expect(text).toContain('18');
    expect(text).toContain('Waited 6 minutes');
  });
});
