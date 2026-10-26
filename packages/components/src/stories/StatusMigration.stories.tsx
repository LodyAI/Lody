import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { WorkingGrid } from '../ui/working-grid';
import { WorkingGridCollapse } from '../ui/working-grid-collapse';
import { WorkingStatusMark } from '../ui/working-status-mark';
import { Spinner } from '../ui/spinner';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    padding: themeSpace[4],
    minHeight: '100dvh',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  items: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: themeSpace[6] },
  sample: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    minHeight: 48,
    paddingBlock: themeSpace[2],
  },
  column: { display: 'flex', flexDirection: 'column', gap: themeSpace[3] },
  controls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: themeSpace[2],
    marginBottom: themeSpace[4],
  },
  mark: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32 },
  spinner: { width: themeSpace[5], height: themeSpace[5] },
  largeSpinner: { width: 48, height: 48 },
});

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(styles.canvas)} data-status-fixture="">
      <p>Status migration · Ready</p>
      {children}
    </div>
  );
}

function GridSamples() {
  return (
    <Frame>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.items)}>
          <WorkingGrid data-status-grid="default" />
          <WorkingGrid data-status-grid="large" size={96} />
          <span>Default and enlarged</span>
        </div>
        <div {...stylex.props(styles.items)}>
          <WorkingGrid data-status-grid="bottom" size={72} scale="bottom" />
          <WorkingGrid data-status-grid="two-waves" size={72} waves={2} />
          <WorkingGrid data-status-grid="vanishing" size={72} waves={2} minScale={-0.25} />
          <span>Bottom origin, crossing waves and vanishing tiles</span>
        </div>
        <div {...stylex.props(styles.items)}>
          <WorkingGrid data-status-grid="superellipse" size={72} superellipse={4} />
          <WorkingGrid data-status-grid="fixed-scale" size={72} scale="none" minOpacity={0.5} />
          <WorkingGrid data-status-grid="uncompensated" size={72} lightCompensation={false} />
          <span>Shape, fixed scale and theme compensation</span>
        </div>
      </div>
    </Frame>
  );
}

function CallerComposition() {
  return (
    <Frame>
      <div {...stylex.props(styles.sample)}>
        <WorkingGrid
          data-status-grid="caller"
          size={64}
          className="block shrink text-primary"
          style={{ marginLeft: 12, opacity: 0.65, color: 'rgb(72, 110, 160)' }}
        />
        <span>Caller class and inline style</span>
      </div>
      <div {...stylex.props(styles.sample)}>
        <WorkingGridCollapse
          data-status-collapse="caller"
          size={64}
          gridSize={56}
          dotSize={24}
          className="block shrink text-primary"
          style={{ marginLeft: 12, color: 'rgb(72, 110, 160)' }}
        />
        <span>Collapse caller class and inline style</span>
      </div>
    </Frame>
  );
}

function CollapseSamples() {
  const [done, setDone] = useState(0);
  return (
    <Frame>
      <div {...stylex.props(styles.items)}>
        <WorkingGridCollapse data-status-collapse="small" onDone={() => setDone((n) => n + 1)} />
        <WorkingGridCollapse
          data-status-collapse="large"
          size={96}
          gridSize={84}
          dotSize={48}
          onDone={() => setDone((n) => n + 1)}
        />
        <output data-status-collapse-done="">Completed {done}</output>
      </div>
    </Frame>
  );
}

function StatusSamples() {
  return (
    <Frame>
      <div {...stylex.props(styles.column)}>
        {[
          ['Working', true, false],
          ['Working with unread', true, true],
          ['Unread', false, true],
          ['Idle', false, false],
        ].map(([label, working, unread]) => (
          <div key={String(label)} {...stylex.props(styles.sample)}>
            <span {...stylex.props(styles.mark)} data-status-sample={String(label)}>
              <WorkingStatusMark
                working={Boolean(working)}
                unread={Boolean(unread)}
                className="text-primary"
              />
            </span>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function StatusTransition() {
  const [working, setWorking] = useState(true);
  const [unread, setUnread] = useState(false);
  return (
    <Frame>
      <div {...stylex.props(styles.controls)}>
        <Button
          onClick={() => {
            setWorking(true);
            setUnread(false);
          }}
        >
          Start working
        </Button>
        <Button
          onClick={() => {
            setWorking(false);
            setUnread(true);
          }}
        >
          Finish unread
        </Button>
        <Button
          onClick={() => {
            setWorking(false);
            setUnread(false);
          }}
        >
          Clear status
        </Button>
      </div>
      <div {...stylex.props(styles.sample)}>
        <span {...stylex.props(styles.mark)} data-status-transition="">
          <WorkingStatusMark working={working} unread={unread} className="text-primary" />
        </span>
        <output>{working ? 'Working' : unread ? 'Unread' : 'Idle'}</output>
      </div>
    </Frame>
  );
}

function SpinnerSamples() {
  return (
    <Frame>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.sample)}>
          <Spinner {...stylex.props(styles.spinner)} data-status-spinner="default" />
          <Spinner {...stylex.props(styles.largeSpinner)} data-status-spinner="large" />
          <span>Default icon spins</span>
        </div>
        <div {...stylex.props(styles.sample)}>
          <Spinner
            {...stylex.props(styles.spinner)}
            icon={RefreshCw}
            spinning={false}
            data-status-spinner="rest"
          />
          <Spinner
            {...stylex.props(styles.largeSpinner)}
            icon={RefreshCw}
            strokeWidth={1}
            data-status-spinner="custom"
          />
          <span>Resting and custom refresh icons</span>
        </div>
        <div {...stylex.props(styles.sample)}>
          <Spinner
            icon={RefreshCw}
            data-status-spinner="caller"
            className="block h-6 w-8 text-primary"
            style={{ marginLeft: 12, color: 'rgb(72, 110, 160)' }}
          />
          <span>Caller layout and inline color</span>
        </div>
      </div>
    </Frame>
  );
}

function SpinnerToggle() {
  const [spinning, setSpinning] = useState(false);
  return (
    <Frame>
      <div {...stylex.props(styles.controls)}>
        <Button onClick={() => setSpinning((value) => !value)}>Toggle spinner</Button>
      </div>
      <div {...stylex.props(styles.sample)}>
        <Spinner
          {...stylex.props(styles.spinner)}
          icon={RefreshCw}
          spinning={spinning}
          data-status-spinner="toggle"
        />
        <output>{spinning ? 'Spinning' : 'Resting'}</output>
      </div>
    </Frame>
  );
}

const meta = { title: 'UI/StatusMigration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Grids: Story = { render: () => <GridSamples /> };
export const CallerOverrides: Story = { render: () => <CallerComposition /> };
export const Collapse: Story = { render: () => <CollapseSamples /> };
export const States: Story = { render: () => <StatusSamples /> };
export const Transition: Story = { render: () => <StatusTransition /> };
export const Spinners: Story = { render: () => <SpinnerSamples /> };
export const SpinnerState: Story = { render: () => <SpinnerToggle /> };
