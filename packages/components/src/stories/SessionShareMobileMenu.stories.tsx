import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { createStore, Provider } from 'jotai';
import {
  createLocalPlatformProvider,
  createStaticStore,
  CLOUD_PLATFORM_CAPABILITIES,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { SessionId, MachineId, WorkspaceId } from '@lody/shared';
import { userAtom } from '@/atoms';
import { SessionShareMobileMenu } from '@/components/sharing/session-share-mobile-menu';

// This story verifies the separate mobile entry and modal handoff. The ready
// management states are rendered by Sharing/SessionShareManager stories.
function MenuStory({ local = false }: { local?: boolean }) {
  const [open, setOpen] = useState(true);
  const [store] = useState(() => {
    const value = createStore();
    value.set(userAtom, null);
    return value;
  });
  const [platform] = useState(() =>
    createLocalPlatformProvider({
      session: createStaticStore({ status: 'unauthenticated' }),
      workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
    })
  );
  return (
    <Provider store={store}>
      <PlatformContext.Provider
        value={{
          ...platform,
          capabilities: local ? platform.capabilities : CLOUD_PLATFORM_CAPABILITIES,
        }}
      >
        <button onClick={() => setOpen(true)}>Open menu</button>
        <SessionShareMobileMenu
          workspaceId={'story-workspace' as WorkspaceId}
          session={{
            id: 'child' as SessionId,
            parentSessionId: 'root' as SessionId,
            userId: 'author',
            machineId: 'story-machine' as MachineId,
            cliType: 'builtin',
            agentType: 'claude',
            createdAt: '2026-09-07T00:00:00Z',
            title: 'Streaming and attachments',
          }}
          open={open}
          onOpenChange={setOpen}
          infoRows={[]}
          actions={[]}
        />
      </PlatformContext.Provider>
    </Provider>
  );
}
const meta = {
  title: 'Sharing/SessionShareMobileMenu',
  component: MenuStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MenuStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Cloud: Story = {};
export const Local: Story = { args: { local: true } };
