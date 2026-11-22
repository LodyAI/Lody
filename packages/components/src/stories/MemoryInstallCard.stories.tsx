import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { MemoryInstallCard } from '@/components/settings/memory-install';
import { MemoryProviderLogo } from '@/components/settings/memory-setting';
import { memoryProviderStoryState, memoryReply } from './memory-provider-story-state';

const missing = memoryReply({ status: 'not_installed' });
const clickInstall: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getAllByRole('button')[0]!);
};

const meta = {
  title: 'Settings/MemoryInstallCard',
  component: MemoryInstallCard,
  args: {
    logo: <MemoryProviderLogo providerId="everme" brandColor decorative />,
    name: 'EverMe',
    providerKey: 'everme',
    installUrl: 'https://evermind.ai/everme',
    reason: 'missing',
    state: memoryProviderStoryState(missing),
  },
} satisfies Meta<typeof MemoryInstallCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Missing: Story = {};
/** Installed, but its CLI cannot be read: the same card offers an update. */
export const Unreadable: Story = {
  args: { reason: 'unreadable', state: memoryProviderStoryState(memoryReply({ status: 'error' })) },
};
/** A provider Lody cannot install only links to its own page. */
export const LinkOnly: Story = {
  args: {
    logo: <MemoryProviderLogo providerId="nowledge-mem" brandColor decorative />,
    name: 'Nowledge Mem',
    providerKey: 'nowledge-mem',
    installUrl: 'https://mem.nowledge.co/en',
    reason: undefined,
  },
};
export const Installing: Story = {
  args: {
    state: memoryProviderStoryState(missing, {
      install: async () =>
        memoryReply({ ...missing, install: { status: 'running', step: 'provider' } }),
    }),
  },
  play: clickInstall,
};
/** The step arrives with the first poll, a few seconds after the click. */
export const InstallingNodeFirst: Story = {
  args: {
    state: memoryProviderStoryState(missing, {
      install: async () =>
        memoryReply({ ...missing, install: { status: 'running', step: 'runtime' } }),
      installPoll: async () =>
        memoryReply({ ...missing, install: { status: 'running', step: 'runtime' } }),
    }),
  },
  play: clickInstall,
};
export const FailedWithoutPermission: Story = {
  args: {
    state: memoryProviderStoryState(missing, {
      install: async () =>
        memoryReply({ ...missing, install: { status: 'failed', failure: 'permission' } }),
    }),
  },
  play: clickInstall,
};
export const FailedUnexplained: Story = {
  args: {
    state: memoryProviderStoryState(missing, {
      install: async () => memoryReply({ ...missing, install: { status: 'failed' } }),
    }),
  },
  play: clickInstall,
};
/** npm reported success, yet this daemon still cannot find the command. */
export const InstalledButNotFound: Story = {
  args: {
    state: memoryProviderStoryState(missing, {
      install: async () => memoryReply({ ...missing, install: { status: 'done' } }),
    }),
  },
  play: clickInstall,
};
