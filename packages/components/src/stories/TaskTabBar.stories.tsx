import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { TaskTabBar, type TaskTabItem } from '@/components/tasks/task-tab-bar';
import { Button } from '@lody/ui/button';

const meta = {
  title: 'Tasks/TaskTabBar',
  component: TaskTabBar,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleTabs: TaskTabItem[] = [
  { taskId: 't1', title: 'Exp some task' },
  { taskId: 't2', title: 'Refactor the auth flow' },
  { taskId: 't3', title: '' },
];

function InteractiveBar({
  initialActive,
  tabs = sampleTabs,
}: {
  initialActive: string | null;
  tabs?: TaskTabItem[];
}) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialActive);
  const [openTabs, setOpenTabs] = useState(tabs);
  return (
    <TaskTabBar
      tabs={openTabs}
      activeTaskId={activeTaskId}
      onSelectAll={() => setActiveTaskId(null)}
      onSelectTask={setActiveTaskId}
      onCloseTask={(taskId) => {
        setOpenTabs((previous) => previous.filter((tab) => tab.taskId !== taskId));
        if (activeTaskId === taskId) {
          setActiveTaskId(null);
        }
      }}
      rightSlot={
        activeTaskId === null ? (
          <Button size="small">
            <Plus className="h-4 w-4" />
            New task
          </Button>
        ) : null
      }
    />
  );
}

/** Home tab only — reads as page chrome rather than a selected pill. */
export const AllTasksOnly: Story = {
  args: {
    tabs: [],
    activeTaskId: null,
    onSelectAll: () => {},
    onSelectTask: () => {},
    onCloseTask: () => {},
  },
  render: () => <InteractiveBar initialActive={null} tabs={[]} />,
};

/** All Tasks active with open detail tabs beside it. */
export const AllTasksActive: Story = {
  args: {
    tabs: sampleTabs,
    activeTaskId: null,
    onSelectAll: () => {},
    onSelectTask: () => {},
    onCloseTask: () => {},
  },
  render: () => <InteractiveBar initialActive={null} />,
};

/** A detail tab is selected; All Tasks is still one click away. */
export const TaskActive: Story = {
  args: {
    tabs: sampleTabs,
    activeTaskId: 't1',
    onSelectAll: () => {},
    onSelectTask: () => {},
    onCloseTask: () => {},
  },
  render: () => <InteractiveBar initialActive="t1" />,
};
