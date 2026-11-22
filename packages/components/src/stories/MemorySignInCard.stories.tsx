import type { Meta, StoryObj } from '@storybook/react';
import { MemorySignInCard } from '@/components/settings/memory-sign-in';
import { MemoryProviderLogo } from '@/components/settings/memory-setting';
import { memoryProviderStoryState, memoryReply } from './memory-provider-story-state';

const signedOut = memoryReply({ status: 'not_running' });

const meta = {
  title: 'Settings/MemorySignInCard',
  component: MemorySignInCard,
  args: {
    logo: <MemoryProviderLogo providerId="everme" brandColor decorative />,
    name: 'EverMe',
    providerKey: 'everme',
    state: memoryProviderStoryState(signedOut),
  },
} satisfies Meta<typeof MemorySignInCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The button starts a real device flow in the product. Here it opens the
 * synthetic approval page below; a browser that blocks the window shows the
 * one-time code instead, which is the stranded state.
 */
export const SignedOut: Story = {
  args: {
    state: memoryProviderStoryState(signedOut, {
      signIn: async () =>
        memoryReply({
          ...signedOut,
          signIn: {
            status: 'pending',
            verificationUrl: 'https://example.com/device?code=ABCD-1234',
            userCode: 'ABCD-1234',
            expiresInSec: 600,
          },
        }),
      signInPoll: async () => memoryReply({ ...signedOut, signIn: { status: 'pending' } }),
    }),
  },
};
/** Reached straight from a finished install, when EverCLI cannot start a flow. */
export const CouldNotStart: Story = {
  args: { autoStart: true, state: memoryProviderStoryState(memoryReply({ status: 'error' })) },
};
