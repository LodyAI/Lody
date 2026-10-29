import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { SessionId, SessionMeta } from '@lody/shared';
import { OperationReplyCard } from '@/components/ai-gui/operation-reply-card';
import { SessionHeaderMenu } from '@/components/sessions/session-chat-interface';
import { SettingsStoryProviders } from './settings-story-shell';
import { parentInkTheme } from './message-action-colors-fixture.stylex';
import { parentControlTheme } from './no-background-action-colors-fixture.stylex';

const styles = stylex.create({
  frame: { maxWidth: 800, padding: 20 },
  section: { marginBottom: 24 },
  receipt: { display: 'block', fontSize: 12, overflowWrap: 'anywhere' },
});
const sessionId = 'no-background-action-session' as SessionId;
const session = {
  id: sessionId,
  machineId: 'no-background-action-machine',
  userId: 'no-background-action-user',
  cliType: 'builtin',
  agentType: 'codex',
  createdAt: '2026-10-29T00:00:00.000Z',
  title: 'Synthetic operation target',
  project: { kind: 'github', repoFullName: 'synthetic/fixture', branch: 'main' },
} as SessionMeta;

function Fixture({ scoped = false }: { scoped?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [navigation, setNavigation] = useState('none');
  const [menuAction, setMenuAction] = useState('none');
  useLayoutEffect(() => {
    if (scoped) {
      for (const button of root.current?.querySelectorAll<HTMLElement>(
        'button[data-variant="ghost"]'
      ) ?? []) {
        button.style.setProperty('--muted-foreground', '190 90% 25%');
        button.style.setProperty('--foreground', '300 75% 45%');
        button.style.setProperty('--hover', '40 100% 60%');
        button.style.setProperty('--spacing', '5px');
        button.dataset.localInk = 'ready';
      }
    }
    setReady(true);
  }, [scoped]);
  return (
    <div
      ref={root}
      data-no-bg-colors={scoped ? 'scoped' : 'default'}
      data-no-bg-ready={ready}
      {...stylex.props(styles.frame, scoped && parentControlTheme, scoped && parentInkTheme)}
    >
      <section data-no-bg-case="operation" {...stylex.props(styles.section)}>
        <OperationReplyCard
          sessionId={sessionId}
          fallbackTitle="Synthetic operation target with a long descriptive title"
          status="succeeded"
          reply="Synthetic reply text retained by the real operation card."
          onNavigateSession={(target) => setNavigation(target.sessionId)}
        />
      </section>
      <section data-no-bg-case="disabled" {...stylex.props(styles.section)}>
        <OperationReplyCard
          sessionId={sessionId}
          fallbackTitle="Synthetic unavailable target"
          status="failed"
          error="Synthetic operation failure; navigation is unavailable."
        />
      </section>
      <section data-no-bg-case="more" {...stylex.props(styles.section)}>
        <SessionHeaderMenu
          session={session}
          onCopyUrl={() => setMenuAction('copy-url')}
          onRename={() => setMenuAction('rename')}
          onArchive={() => setMenuAction('archive')}
          t={(_key, fallback, options) =>
            Object.entries(options ?? {}).reduce(
              (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
              fallback
            )
          }
        />
      </section>
      <output {...stylex.props(styles.receipt)} data-no-bg-navigation={navigation}>
        Navigation: {navigation}
      </output>
      <output {...stylex.props(styles.receipt)} data-no-bg-menu-action={menuAction}>
        Menu action: {menuAction}
      </output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedNoBackgroundActionColors',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Provider>
        <SettingsStoryProviders>
          <Story />
        </SettingsStoryProviders>
      </Provider>
    ),
  ],
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Scoped: Story = { args: { scoped: true } };
