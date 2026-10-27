// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  AiUsageSettingsView,
  type AiUsageSettingsViewProps,
} from '../src/components/settings/ai-usage-setting-view';
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

  it('renders live quota, usage, attribution, and waiting sections', async () => {
    await act(async () => {
      root.render(
        <AiUsageSettingsView
          quotaRows={quotaRows}
          quotaLoading={false}
          onRefreshQuota={() => undefined}
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
    expect(text).not.toContain('Remaining distribution');
    expect(text).toContain('Claude Code');
    expect(text).toContain('62%');
    expect(text).toContain('Not reported');
    expect(text).not.toContain('Quota history');
    expect(text).toContain('Provider and machine');
    expect(text).toContain('Breakdown');
    expect(text).toContain('By model');
    expect(text).toContain('Waiting to resume');
    expect(text).toContain('18');
    expect(text).toContain('Waited 6 minutes');
  });
  it('separates quota from consumption and shows every reported window without a disclosure', async () => {
    const props: AiUsageSettingsViewProps = {
      quotaRows,
      quotaLoading: false,
      onRefreshQuota: () => undefined,
      usageLoading: false,
      byModelBuckets: [{ label: 'Mon', values: [] }],
      providerRows: [
        {
          key: 'claude',
          label: 'Claude',
          machines: ['MacBook Pro'],
          tokens: 1000,
          costUSD: 0.1,
          share: 100,
          quotaPercent: 62,
        },
      ],
    };
    props.quotaRows = [
      {
        ...quotaRows[0]!,
        planName: 'Pro',
        windows: [
          quotaRows[0]!.windows[0]!,
          {
            usedPercent: 56,
            remainingPercent: 44,
            windowDurationSeconds: 604800,
            resetsAtEpochSeconds: null,
          },
          {
            usedPercent: 82,
            remainingPercent: 18,
            windowDurationSeconds: 2592000,
            resetsAtEpochSeconds: null,
          },
        ],
      },
      quotaRows[1]!,
    ];
    await act(async () => root.render(<AiUsageSettingsView {...props} surface="usage" />));
    let headings = [...container.querySelectorAll('h2')].map((node) => node.textContent);
    expect(headings).toEqual(['Breakdown']);
    expect(container.textContent).not.toContain('Live quota');
    expect(container.textContent).not.toContain('Quota history');

    await act(async () => root.render(<AiUsageSettingsView {...props} surface="quota" />));
    headings = [...container.querySelectorAll('h2')].map((node) => node.textContent);
    expect(headings).toEqual(['Live quota']);
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).toContain('62%');
    expect(container.textContent).toContain('Not reported');
    expect(container.querySelector('button')?.textContent).toBe('Refresh');
    expect(container.querySelector('[aria-label="Usage dimension"]')).toBeNull();
    expect(container.textContent).not.toContain('Quota history');
    expect(container.textContent).toContain('18%');
    expect(container.textContent).toContain('44%');
    expect(container.querySelector('button[aria-label="Quota details"]')).toBeNull();
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(container.textContent).not.toContain('View in Agents');
  });

  it('only raises quota attention for a visible online source with an exhausted window', async () => {
    const props = { quotaRows, quotaLoading: false, usageLoading: false, providerRows: [] };
    await act(async () => root.render(<AiUsageSettingsView {...props} surface="quota" />));
    expect(container.textContent).not.toContain('exhausted quota window');
    const exhausted = {
      ...quotaRows[0]!,
      windows: [{ ...quotaRows[0]!.windows[0]!, remainingPercent: 0, usedPercent: 100 }],
    };
    await act(async () =>
      root.render(<AiUsageSettingsView {...props} quotaRows={[exhausted]} surface="quota" />)
    );
    expect(container.textContent).toContain('1 configuration has an exhausted quota window');
    await act(async () =>
      root.render(
        <AiUsageSettingsView
          {...props}
          quotaRows={[{ ...exhausted, machineOnline: false }]}
          surface="quota"
        />
      )
    );
    expect(container.textContent).not.toContain('exhausted quota window');
    expect(container.textContent).toContain('Offline');
  });
});
