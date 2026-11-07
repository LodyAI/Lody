import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { GitBranch, MessagesSquare, MonitorPlay, Target } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { SESSION_GOAL_COMMANDS } from '@lody/shared';
import {
  ActionChip,
  ClusterChip,
  PopoverActionChip,
  StageChip,
} from '../components/sessions/info-chip';
import {
  ContextChip,
  GoalChip,
  PrCiPill,
  ScheduleSourceChip,
  StatusChip,
  type PrCiRun,
} from '../components/sessions/session-info-chips';
import { SessionInfoBar } from '../components/sessions/session-info-bar';

const meta = {
  title: 'Sessions/InfoChipStyleMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const longLabel = 'A very long descriptive repository / feature / branch label 中文边界检查';
const ciRuns: PrCiRun[] = [
  { name: longLabel, status: 'failure', durationMs: 123_000, url: 'https://example.com/check' },
  { name: 'Build', status: 'success', durationMs: 61_000 },
  { name: 'Integration tests', status: 'running' },
  { name: 'Waiting for runner', status: 'queued' },
  { name: 'Optional deployment', status: 'skipped' },
  { name: 'Cancelled attempt', status: 'cancelled' },
];

// The fixture supplies the available container and space for real portalled panels.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div style={{ paddingTop: 320 }}>
      <div
        data-info-bar-surface=""
        data-info-chip-fixture=""
        style={{ display: 'flex', containerType: 'inline-size', width: '100%', minWidth: 0 }}
      >
        {children}
      </div>
    </div>
  );
}

function PrimitivesFixture() {
  const [selected, setSelected] = useState(false);
  const [result, setResult] = useState('Ready');
  return (
    <>
      <Frame>
        <ActionChip
          icon={MonitorPlay}
          label="Open preview"
          onAction={() => setResult('Preview opened')}
        />
        <ClusterChip
          icon={Target}
          value="12m"
          label="Promote goal"
          onPromote={() => setSelected(true)}
        />
        <StageChip
          icon={GitBranch}
          value="#12345"
          label="Current stage"
          summary={selected ? `Promoted · ${longLabel}` : longLabel}
          detail={{
            kind: 'action',
            ariaLabel: 'Open stage details',
            onAction: () => setResult('Stage opened'),
          }}
        />
      </Frame>
      <output data-info-chip-result="">{result}</output>
    </>
  );
}
export const Primitives: Story = { render: () => <PrimitivesFixture /> };

export const AnchoredPopover: Story = {
  render: () => (
    <Frame>
      <PopoverActionChip
        icon={MessagesSquare}
        label="Related sessions"
        value="2/5"
        content={(close) => <Button onClick={close}>Close related sessions</Button>}
      />
    </Frame>
  ),
};

export const StagePopover: Story = {
  render: () => (
    <Frame>
      <StageChip
        icon={Target}
        value="12m"
        label="Stage goal"
        summary={longLabel}
        detail={{ kind: 'popover', ariaLabel: 'Open goal details', content: <p>{longLabel}</p> }}
      />
    </Frame>
  ),
};

function ContextFixture({ disabled = false }: { disabled?: boolean }) {
  const [result, setResult] = useState('Ready');
  return (
    <>
      <Frame>
        <ContextChip
          mode="stage"
          projectName={longLabel}
          branch="feature/extremely-long-branch-for-truncation-and-container-boundary-checks"
          pr={{ url: 'https://github.com/example/synthetic/pull/12345', status: 'open' }}
          prCiRuns={ciRuns}
          onOpenPrCiRun={() => setResult('CI run opened')}
          onOpenPr={() => setResult('PR opened')}
          diffStat={{ add: 12345, del: 6789 }}
          onOpenAllChanges={disabled ? undefined : () => setResult('Changes opened')}
          actions={[
            {
              id: 'commit',
              label: 'Commit & Push',
              disabled,
              onClick: () => setResult('Commit requested'),
            },
            {
              id: 'fix-ci',
              label: 'Fix CI Errors',
              disabled,
              onClick: () => setResult('CI fix requested'),
            },
          ]}
        />
      </Frame>
      <output data-info-chip-result="">{result}</output>
    </>
  );
}
export const ContextActions: Story = { render: () => <ContextFixture /> };
export const ContextDisabled: Story = { render: () => <ContextFixture disabled /> };

export const GoalCleared: Story = {
  render: () => (
    <Frame>
      <GoalChip
        mode="stage"
        goal={{ type: 'goal', threadId: 'synthetic-goal', objective: longLabel, status: 'cleared' }}
        commands={SESSION_GOAL_COMMANDS}
        onDismiss={() => {}}
      />
    </Frame>
  ),
};

function StatusSourceFixture() {
  const [stage, setStage] = useState(false);
  return (
    <Frame>
      <StatusChip
        state={{ kind: 'machine-removed' }}
        mode="cluster"
        onPromote={() => setStage(true)}
      />
      <StatusChip
        state={{ kind: 'browser-offline' }}
        mode="cluster"
        onPromote={() => setStage(false)}
      />
      {stage ? (
        <StatusChip state={{ kind: 'machine-removed' }} mode="stage" />
      ) : (
        <ScheduleSourceChip mode="stage" title={longLabel} onOpen={() => setStage(true)} />
      )}
    </Frame>
  );
}
export const StatusAndSource: Story = { render: () => <StatusSourceFixture /> };

export const FullBar: Story = {
  render: () => (
    <div style={{ paddingTop: 320 }}>
      <SessionInfoBar
        status={{ kind: 'machine-removed' }}
        goal={{ type: 'goal', threadId: 'synthetic-goal', objective: longLabel, status: 'paused' }}
        scheduleSource={{ title: longLabel, onOpen: () => {} }}
        projectName={longLabel}
        branch="feature/extremely-long-branch-name-for-mobile-truncation"
        pr={{ url: 'https://github.com/example/synthetic/pull/12345', status: 'open' }}
        prCiRuns={ciRuns}
        onOpenPr={() => {}}
        onOpenPrCiRun={() => {}}
        diffStat={{ add: 12345, del: 6789 }}
        onOpenAllChanges={() => {}}
        contextActions={[{ id: 'commit', label: 'Commit & Push', onClick: () => {} }]}
        initialStage="context"
      />
    </div>
  ),
};

export const CiDetails: Story = {
  render: () => (
    <Frame>
      <PrCiPill runs={ciRuns} onOpenRun={() => {}} />
    </Frame>
  ),
};
