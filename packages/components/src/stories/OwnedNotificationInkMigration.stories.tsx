import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore, useAtomValue } from 'jotai';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { TestCloudPlatformProvider } from '../../tests/test-platform';
import { currentWorkspaceSlugAtom, notificationPromptDismissedAtom, userAtom } from '@/atoms';
import { NotificationPermissionPrompt } from '@/components/sessions/notification-permission-prompt';
import { parentControlTheme } from './no-background-action-colors-fixture.stylex';
import { parentInkTheme } from './message-action-colors-fixture.stylex';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    minHeight: '100dvh',
    paddingTop: 24,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  receipt: { display: 'block', margin: 16, fontSize: 12 },
});
const palette = {
  '--muted-foreground': '190 90% 25%',
  '--foreground': '300 75% 45%',
} as CSSProperties;

function Prompt({ scope }: { scope: 'default' | 'root' | 'subtree' | 'parent' }) {
  const dismissed = useAtomValue(notificationPromptDismissedAtom);
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target =
      scope === 'root' ? document.documentElement : scope === 'subtree' ? root.current : null;
    const previous = Object.keys(palette).map((name) => [
      name,
      target?.style.getPropertyValue(name) ?? '',
    ]);
    if (target)
      for (const [name, value] of Object.entries(palette)) target.style.setProperty(name, value);
    setReady(true);
    return () => {
      if (!target) return;
      for (const [name, value] of previous) {
        if (value) target.style.setProperty(name, value);
        else target.style.removeProperty(name);
      }
    };
  }, [scope]);
  return (
    <div
      ref={root}
      data-notification-ink={scope}
      data-notification-ready={ready}
      data-dismissed={dismissed}
      {...stylex.props(
        styles.frame,
        scope === 'parent' && parentControlTheme,
        scope === 'parent' && parentInkTheme
      )}
    >
      {ready ? <NotificationPermissionPrompt sessionCompleted /> : null}
      <output {...stylex.props(styles.receipt)}>
        Synthetic dismissed preference: {String(dismissed)}
      </output>
    </div>
  );
}
function Fixture({ scope = 'default' }: { scope?: 'default' | 'root' | 'subtree' | 'parent' }) {
  const [store] = useState(() => {
    const result = createStore();
    result.set(currentWorkspaceSlugAtom, 'notification-ink-synthetic');
    result.set(notificationPromptDismissedAtom, false);
    result.set(userAtom, {
      id: 'notification-ink-user',
      name: 'Synthetic Notification User',
      email: 'notification@example.invalid',
      image: null,
    });
    return result;
  });
  return (
    <TestCloudPlatformProvider>
      <Provider store={store}>
        <Prompt scope={scope} />
      </Provider>
    </TestCloudPlatformProvider>
  );
}
const meta = {
  title: 'Migration/OwnedNotificationInk',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeDefault: Story = { render: () => <Fixture /> };
export const RootPalette: Story = { render: () => <Fixture scope="root" /> };
export const SubtreePalette: Story = { render: () => <Fixture scope="subtree" /> };
export const ParentTokens: Story = { render: () => <Fixture scope="parent" /> };
