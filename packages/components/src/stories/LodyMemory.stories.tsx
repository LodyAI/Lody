import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type MemoryAssociation,
  type MemoryBinding,
} from '@lody/shared';
import { useResolvedTheme } from '@/theme-provider';
import {
  LodyMemorySectionView,
  MemoryAssociationList,
  RoleLodyMemoryList,
} from '@/components/settings/memory-setting';

const role = (id: string, name: string, emoji: string): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: id as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'workspace',
  name,
  emoji,
  machineId: 'machine' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});
const lody = (memoryId: string, name: string, description?: string): MemoryAssociation => ({
  machineId: 'machine',
  providerId: 'lody',
  memoryId,
  name,
  ...(description ? { description } : {}),
});
const memories = [
  lody('work', 'Work', 'Team conventions, project decisions and review preferences.'),
  lody('writing', 'Writing', 'Tone, terminology and formatting the user prefers.'),
];
const nowledge: MemoryAssociation[] = [
  {
    machineId: 'machine',
    providerId: 'nowledge-mem',
    memoryId: 'reviewer',
    name: 'Code reviewer',
    description: 'Architecture decisions and lessons from code reviews.',
  },
];
const noop = () => {};

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ width: 640, padding: 24 }}>{children}</div>;
}

function SettingsSection({ rows }: { rows: MemoryAssociation[] }) {
  const theme = useResolvedTheme();
  return (
    <Frame>
      <LodyMemorySectionView
        status="ready"
        rows={rows}
        theme={theme}
        getAssignedRoles={(entry) =>
          entry.memoryId === 'work'
            ? [role('lody', 'Lody', '🐳'), role('pauli', 'Pauli', '🐕')]
            : []
        }
        onAssociateRole={noop}
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
      />
    </Frame>
  );
}

/** The Role editor's memory column: Lody memories first, then integrated providers. */
function RolePicker({ rows, usable }: { rows: MemoryAssociation[]; usable: boolean }) {
  const [value, setValue] = useState<MemoryBinding | undefined>(
    rows[0] ? { providerId: 'lody', memoryId: rows[0].memoryId } : undefined
  );
  return (
    <Frame>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <RoleLodyMemoryList
          rows={rows}
          value={value}
          usable={usable}
          missing={false}
          onSelect={setValue}
          onCreate={noop}
        />
        <MemoryAssociationList
          entries={nowledge}
          selected={value}
          onSelect={(entry) => setValue({ providerId: entry.providerId, memoryId: entry.memoryId })}
        />
      </div>
    </Frame>
  );
}

const meta = {
  title: 'Settings/LodyMemory',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsEmpty: Story = { render: () => <SettingsSection rows={[]} /> };
export const SettingsWithMemories: Story = { render: () => <SettingsSection rows={memories} /> };
export const SettingsUnavailable: Story = {
  render: () => (
    <Frame>
      <LodyMemorySectionView
        status="unavailable"
        rows={[]}
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
      />
    </Frame>
  ),
};
export const RolePickerLocal: Story = { render: () => <RolePicker rows={memories} usable /> };
export const RolePickerRemoteMachine: Story = {
  render: () => <RolePicker rows={memories} usable={false} />,
};
export const RolePickerEmpty: Story = { render: () => <RolePicker rows={[]} usable /> };
