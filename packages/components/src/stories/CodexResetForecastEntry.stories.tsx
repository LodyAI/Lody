import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  getRateLimitEntryKey,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

// The chip is not rendered directly: the provider row below is its only call
// site, and mounting the real row is what proves the gating and the placement.
import { ProviderRow } from '@/components/settings/provider-row';
import { SessionUsagePopover } from '@/components/sessions/session-usage-popover';
import type { CodexResetStatus, CodexResetWatch } from '@/lib/codex-reset-forecast';
import {
  setCodexResetForecastStoreForTests,
  type CodexResetForecastState,
  type CodexResetForecastStore,
} from '@/lib/codex-reset-forecast-store';

const styles = stylex.create({
  entries: {
    display: 'flex',
    width: '560px',
    maxWidth: '100%',
    flexDirection: 'column',
    gap: space[8],
  },
  narrow: { width: '340px' },
});

const NOW_MS = getServerNow();

const watch: CodexResetWatch = {
  level: 'strong',
  chancePercent: 65,
  // Free text off the wire; the entries keep it as its own clause.
  windowText: 'the next 6 hours',
  observedAtIso: new Date(NOW_MS - 3_600_000).toISOString(),
  observedAtMs: NOW_MS - 3_600_000,
  expiresAtIso: new Date(NOW_MS + 5 * 3_600_000).toISOString(),
  expiresAtMs: NOW_MS + 5 * 3_600_000,
  text: 'Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone.',
  source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/1' },
};

const readyState = (data: CodexResetStatus): CodexResetForecastState => ({
  status: 'ready',
  data,
  error: null,
});

/** A store that serves one fixed state, so a story never touches the network. */
const stubStore = (state: CodexResetForecastState): CodexResetForecastStore => ({
  subscribe: () => () => {},
  getState: () => state,
  revalidate: async () => {},
  refresh: async () => {},
});

function WithStubbedForecast({
  state,
  children,
}: {
  state: CodexResetForecastState;
  children: ReactNode;
}) {
  // Installed before the children render, and removed when the story unmounts,
  // so the shared module-level store never leaks between stories.
  useState(() => setCodexResetForecastStoreForTests(stubStore(state)));
  useEffect(() => () => setCodexResetForecastStoreForTests(null), []);
  return <>{children}</>;
}

const machineId = 'machine-1' as MachineId;

const codexMachine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.44.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {
    [getRateLimitEntryKey('codex', 'codex', 'cfg-codex' as AgentConfigId)]: {
      limitId: 'codex',
      scope: { providerId: 'codex' },
      planName: 'ChatGPT Plus',
      windows: [
        {
          usedPercent: 41,
          windowDurationSeconds: 5 * 60 * 60,
          resetsAtEpochSeconds: Math.floor(NOW_MS / 1_000) + 2 * 60 * 60,
        },
        {
          usedPercent: 29,
          windowDurationSeconds: 7 * 24 * 60 * 60,
          resetsAtEpochSeconds: Math.floor(NOW_MS / 1_000) + 5 * 24 * 60 * 60,
        },
      ],
    },
  },
};

const codexConfig: AgentConfigMeta = {
  id: 'cfg-codex' as AgentConfigId,
  machineId,
  name: 'Codex',
  cliType: 'builtin',
  agentType: 'codex',
  description: undefined,
  env: {},
};

type StoryProps = {
  state: CodexResetForecastState;
  showActions?: boolean;
  narrow?: boolean;
  withoutRateLimits?: boolean;
};

/**
 * Both entry points side by side, each in the surface it actually ships in: the
 * composer's usage popover, and the settings provider row beside its rate limits.
 */
function EntryPoints({ state, showActions, narrow, withoutRateLimits }: StoryProps) {
  return (
    <WithStubbedForecast state={state}>
      <div {...stylex.props(styles.entries, narrow && styles.narrow)}>
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Composer usage popover</p>
          <SessionUsagePopover
            contextWindowUsage={{ size: 258_400, used: 203_700 }}
            rateLimits={codexMachine.raceLimits}
            agentType="codex"
            agentConfigId={codexConfig.id}
            modelId="codex"
            modelLabel="5.6-Sol"
            showCodexResetForecast
            className="w-fit"
          />
        </section>

        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Provider row</p>
          <div className="rounded-lg border border-border/60 bg-card/50">
            <ProviderRow
              config={codexConfig}
              machine={withoutRateLimits ? { ...codexMachine, raceLimits: {} } : codexMachine}
              onEdit={() => {}}
              onRefresh={showActions ? async () => {} : undefined}
              onDelete={showActions ? async () => {} : undefined}
            />
          </div>
        </section>
      </div>
    </WithStubbedForecast>
  );
}

const meta = {
  title: 'CodexReset/CodexResetForecastEntry',
  component: EntryPoints,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof EntryPoints>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveForecast: Story = {
  args: { state: readyState({ watch, scheduledReset: null, latestReset: null }) },
};

export const ActiveForecastWithActions: Story = {
  args: { ...ActiveForecast.args, showActions: true },
};

export const ActiveForecastNarrowWithActions: Story = {
  args: { ...ActiveForecastWithActions.args, narrow: true },
};

export const WithoutProbability: Story = {
  args: {
    state: readyState({
      watch: { ...watch, chancePercent: null, level: 'elevated' },
      scheduledReset: null,
      latestReset: null,
    }),
  },
};

/**
 * No forecast in force: the popover row disappears entirely, while the provider
 * row keeps its always-present entry into the dialog.
 */
export const NoActiveWatch: Story = {
  args: { state: readyState({ watch: null, scheduledReset: null, latestReset: null }) },
};

export const NoActiveWatchWithActions: Story = {
  args: { ...NoActiveWatch.args, showActions: true, withoutRateLimits: true },
};

export const ScheduledReset: Story = {
  args: {
    state: readyState({
      watch: null,
      latestReset: null,
      scheduledReset: {
        announcedAtIso: watch.observedAtIso,
        announcedAtMs: watch.observedAtMs,
        scheduledForIso: watch.expiresAtIso,
        scheduledForMs: watch.expiresAtMs,
        text: 'A reset is scheduled for later today.',
        source: watch.source,
      },
    }),
  },
};
