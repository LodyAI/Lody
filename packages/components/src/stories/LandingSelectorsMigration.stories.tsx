import { useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import * as stylex from '@stylexjs/stylex';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { getMachineRoomId, type MachineId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { localProbeResultAtom } from '@/atoms/local-probe';
import { BranchSelector, MachineSelector } from '@/components/chat/chat-landing-selectors';

const id = 'synthetic-253-landing-machine' as MachineId;
const label = 'Synthetic local workstation with a deliberately long display name';
const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const styles = stylex.create({
  surface: {
    minHeight: '100vh',
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    justifyContent: 'flex-end',
    paddingBottom: 80,
  },
});
const options = Array.from({ length: 8 }, (_, i) => ({
  value: `branch-${i}`,
  label:
    i === 0
      ? 'feat/very-long-branch-name-for-real-wrapping-and-overflow-validation'
      : `branch-${i}`,
  description: i === 0 ? 'Synthetic branch description' : undefined,
}));
function Fixture({
  family = 'branch',
  rootSize = 16,
  spacing = '4px',
  disabled = false,
}: {
  family?: 'branch' | 'machine';
  rootSize?: number;
  spacing?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('branch-0');
  const [machine, setMachine] = useState<MachineId | null>(id);
  const [store] = useState(() => {
    const s = createStore();
    s.set(userAtom, {
      id: 'synthetic-253-owner',
      name: 'Synthetic fixture owner',
      email: 'fixture@example.invalid',
    });
    s.set(machineMetaCacheAtom, {
      [getMachineRoomId(id)]: {
        id,
        name: label,
        ownerUserId: 'synthetic-253-owner',
        cliVersion: 'fixture',
        os: 'fixture',
        sessions: [],
      },
    });
    s.set(localProbeResultAtom, { ok: true, machineId: id });
    return s;
  });
  return (
    <Provider store={store}>
      <PlatformContext.Provider value={platform}>
        <div
          {...stylex.props(styles.surface)}
          data-landing-fixture
          data-family={family}
          data-root-size={rootSize}
          data-spacing={spacing}
          style={{ '--spacing': spacing } as CSSProperties}
        >
          <style>{`:root { font-size: ${rootSize}px; --spacing: ${spacing}; }`}</style>
          <textarea
            aria-label="Composer fixture"
            data-keyboard-nav="composer"
            defaultValue="Synthetic composer focus target"
          />
          {family === 'branch' ? (
            <BranchSelector
              value={value}
              onChange={setValue}
              options={options}
              tone="light"
              disabled={disabled}
              searchPlaceholder="Search synthetic branches"
              emptyText="No matching synthetic branch"
            />
          ) : (
            <MachineSelector
              value={machine}
              onChange={setMachine}
              tone="light"
              disabled={disabled}
            />
          )}
          <output data-selection>{family === 'branch' ? value : machine}</output>
        </div>
      </PlatformContext.Provider>
    </Provider>
  );
}
const meta = {
  title: 'Migration/LandingSelectors',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Branch: Story = {};
export const BranchRoot18: Story = { args: { rootSize: 18 } };
export const BranchDisabled: Story = { args: { disabled: true } };
export const Machine: Story = { args: { family: 'machine' } };
export const MachineSpacing6: Story = { args: { family: 'machine', spacing: '6px' } };
export const MachineSpacingInitial: Story = { args: { family: 'machine', spacing: 'initial' } };
