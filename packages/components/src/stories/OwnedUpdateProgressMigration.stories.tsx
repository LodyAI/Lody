import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { SidebarUpdateBanner } from '@/components/sidebar-update-banner';
import { LoroSidebar } from '@/components/loro-sidebar';

const styles = stylex.create({
  frame: { padding: 12, maxWidth: 320 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 },
  sidebar: { height: 720 },
});
function Scene({ caller = 'none' }: { caller?: 'none' | 'sidebar' }) {
  const [percent, setPercent] = useState<number | null>(38);
  const [stage, setStage] = useState<'downloading' | 'downloaded'>('downloading');
  const [restarting, setRestarting] = useState(false);
  const [receipt, setReceipt] = useState('');
  const [version, setVersion] = useState('1.4.2');
  const banner = (
    <SidebarUpdateBanner
      stage={stage}
      version={version}
      percent={percent}
      isRestarting={restarting}
      onViewChangelog={() => setReceipt('changelog')}
      onLater={() => setReceipt('later')}
      onRestart={() => {
        setReceipt('restart');
        setRestarting(true);
      }}
    />
  );
  return (
    <section
      data-update-progress-fixture
      data-caller={caller}
      data-percent={String(percent)}
      data-stage={stage}
    >
      <div {...stylex.props(styles.controls)}>
        {[0, 38, 100].map((n) => (
          <button
            key={n}
            onClick={() => {
              setStage('downloading');
              setPercent(n);
            }}
          >
            Set progress {n}
          </button>
        ))}
        <button
          onClick={() => {
            setStage('downloading');
            setPercent(null);
          }}
        >
          No percent
        </button>
        <button onClick={() => setVersion('1.4.2' + '-release'.repeat(9))}>Long version</button>
        <button onClick={() => setStage('downloaded')}>Downloaded state</button>
        <button
          onClick={() => {
            setStage('downloaded');
            setRestarting(true);
          }}
        >
          Restarting state
        </button>
      </div>
      {caller === 'none' ? (
        <div {...stylex.props(styles.frame)} data-update-banner-host>
          {banner}
        </div>
      ) : (
        <div {...stylex.props(styles.sidebar)} data-update-sidebar-host>
          <LoroSidebar
            workspaceName="Synthetic workspace"
            userEmail=""
            workspaces={[]}
            currentWorkspaceId=""
            workspaceSwitcherEnabled={false}
            repoSections={[]}
            chats={[]}
            bottomFloatingContent={<div data-update-banner-host>{banner}</div>}
          />
        </div>
      )}
      <output data-update-receipt>{receipt}</output>
    </section>
  );
}
const meta = {
  title: 'Migration/OwnedUpdateProgress',
  component: Scene,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Scene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};

export const SidebarHost: Story = { args: { caller: 'sidebar' } };
