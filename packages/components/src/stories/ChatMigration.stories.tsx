import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { ContextSwitch, type SessionContextType } from '@/components/chat/context-switch';
import { MobileConnectionStatus } from '@/components/mobile/mobile-connection-status';
import type { LodyConnectionUiState } from '@/atoms/control-connection';
import { useTheme } from '@/theme-provider';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  stack: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: themeSpace[4] },
  controls: { display: 'flex', flexWrap: 'wrap', gap: themeSpace[2] },
  statusBox: { width: 220, maxWidth: '100%', minHeight: 40 },
  statusStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[4],
    width: 240,
    maxWidth: '100%',
  },
});
const meta = { title: 'Chat/Migration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ContextFixture({ disabled = 'none' }: { disabled?: 'none' | 'tooltip' | 'action' }) {
  const { resolvedTheme } = useTheme();
  const [value, setValue] = useState<SessionContextType>(disabled === 'none' ? 'local' : 'chat');
  const [action, setAction] = useState('None');
  return (
    <Tooltip.Provider>
      <div {...stylex.props(styles.canvas, styles.stack)}>
        <ContextSwitch
          value={value}
          onChange={setValue}
          tone={resolvedTheme === 'dark' ? 'dark' : 'light'}
          localDisabled={
            disabled === 'tooltip'
              ? { label: 'Desktop only' }
              : disabled === 'action'
                ? { label: 'Add folder', onClick: () => setAction('Add folder') }
                : undefined
          }
          githubDisabled={
            disabled === 'action'
              ? { label: 'Connect GitHub', onClick: () => setAction('Connect GitHub') }
              : undefined
          }
        />
        <output aria-label="Selected context">{value}</output>
        <output aria-label="Last action">{action}</output>
        <Button onClick={() => setAction('Outside')}>Outside control</Button>
      </div>
    </Tooltip.Provider>
  );
}
export const ContextTabs: Story = { render: () => <ContextFixture /> };
export const ContextDisabledTooltip: Story = {
  render: () => <ContextFixture disabled="tooltip" />,
};
export const ContextDisabledAction: Story = { render: () => <ContextFixture disabled="action" /> };

function ConnectionStateFixture({ large = false }: { large?: boolean }) {
  return (
    <div
      {...stylex.props(styles.canvas)}
      style={large ? ({ '--ui-font-size': '18px' } as CSSProperties) : undefined}
    >
      <div {...stylex.props(styles.statusStack)}>
        <MobileConnectionStatus state="loading" labels={{ loading: 'Loading' }} />
        <MobileConnectionStatus
          state="reconnecting"
          labels={{ reconnecting: 'Reconnecting to a workspace with a very long label' }}
        />
        <MobileConnectionStatus state="offline" labels={{ offline: 'Offline' }} />
        <MobileConnectionStatus state="offline" refreshing labels={{ refreshing: 'Refreshing' }} />
        <MobileConnectionStatus
          state="offline"
          refreshing
          pull={{ active: true, pastThreshold: false, label: 'Pull to refresh' }}
        />
        <MobileConnectionStatus
          state="online"
          pull={{ active: true, pastThreshold: true, label: 'Release to refresh' }}
        />
      </div>
    </div>
  );
}
export const ConnectionStates: Story = { render: () => <ConnectionStateFixture /> };
export const ConnectionLargeType: Story = { render: () => <ConnectionStateFixture large /> };

function ConnectionControlFixture() {
  const [state, setState] = useState<LodyConnectionUiState>('offline');
  const [refreshing, setRefreshing] = useState(false);
  const [pull, setPull] = useState(false);
  return (
    <div {...stylex.props(styles.canvas, styles.stack)}>
      <div {...stylex.props(styles.statusBox)}>
        <MobileConnectionStatus
          state={state}
          refreshing={refreshing}
          pull={
            pull ? { active: true, pastThreshold: true, label: 'Release to refresh' } : undefined
          }
          labels={{
            offline: 'Offline',
            recovered: 'Connected',
            refreshing: 'Refreshing',
            reconnecting: 'Reconnecting',
          }}
        />
      </div>
      <div {...stylex.props(styles.controls)}>
        <Button onClick={() => setState('online')}>Connect</Button>
        <Button onClick={() => setState('offline')}>Disconnect</Button>
        <Button onClick={() => setState('reconnecting')}>Reconnect</Button>
        <Button onClick={() => setRefreshing((value) => !value)}>Toggle refresh</Button>
        <Button onClick={() => setPull((value) => !value)}>Toggle pull</Button>
      </div>
    </div>
  );
}
export const ConnectionControls: Story = { render: () => <ConnectionControlFixture /> };
