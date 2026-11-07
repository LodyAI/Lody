import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { TestCloudPlatformProvider } from '../../tests/test-platform';
import { Provider, createStore } from 'jotai';
import { useEffect, useState, type ReactNode } from 'react';

import { currentWorkspaceSlugAtom, notificationPromptDismissedAtom, userAtom } from '@/atoms';
import { NotificationPermissionPrompt } from '@/components/sessions/notification-permission-prompt';
const storyLayout = stylex.create({
  frame: {
    'min-height': 'calc(var(--spacing) * 40)',
    width: '100%',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-block': 'calc(var(--spacing) * 6)',
  },
});

const storyStore = createStore();
storyStore.set(currentWorkspaceSlugAtom, 'storybook');
storyStore.set(notificationPromptDismissedAtom, false);
storyStore.set(userAtom, {
  id: 'notification-prompt-story-user',
  name: 'Storybook User',
  email: 'storybook@example.com',
  image: null,
});

function DefaultNotificationPermission({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
    const notificationMock = function Notification() {};
    Object.defineProperty(notificationMock, 'permission', {
      configurable: true,
      value: 'default',
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: notificationMock,
    });
    setReady(true);

    return () => {
      if (originalDescriptor) {
        Object.defineProperty(window, 'Notification', originalDescriptor);
      } else {
        Reflect.deleteProperty(window, 'Notification');
      }
    };
  }, []);

  return ready ? children : null;
}

const meta = {
  title: 'Sessions/NotificationPermissionPrompt',
  component: NotificationPermissionPrompt,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <TestCloudPlatformProvider>
        <Provider store={storyStore}>
          <DefaultNotificationPermission>
            <div {...stylex.props(storyLayout.frame)}>
              <Story />
            </div>
          </DefaultNotificationPermission>
        </Provider>
      </TestCloudPlatformProvider>
    ),
  ],
  args: {
    sessionCompleted: true,
  },
} satisfies Meta<typeof NotificationPermissionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
