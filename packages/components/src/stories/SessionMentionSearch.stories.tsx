import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { MachineId, MachineViewMeta, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';
import { getSessionRoomId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { machineMetaCacheAtom, sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { ChatComposer } from '@/components/chat/chat-composer';
import { SettingsStoryProviders } from './settings-story-shell';

const machineId = 'b07-synthetic-machine' as MachineId;
const userId = 'b07-synthetic-user';

function createSessionSearchStore() {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'settings-story-workspace' as WorkspaceId);
  store.set(userAtom, { id: userId, name: 'Synthetic user', email: 'fixture@example.invalid' });
  store.set(machineMetaCacheAtom, {
    [machineId]: {
      id: machineId,
      name: 'Synthetic machine',
      os: 'macOS',
      cliVersion: '1.0.0',
      ownerUserId: userId,
      sessions: [],
      raceLimits: {},
    } as MachineViewMeta,
  });
  const sessions: Record<string, SessionMeta> = {};
  for (let index = 0; index < 15; index++) {
    const id = `b07-synthetic-session-${index}` as SessionId;
    sessions[getSessionRoomId(id)] = {
      id,
      machineId,
      userId,
      title: index < 14 ? `No project conversation ${index + 1}` : 'Elsewhere parser work',
      createdAt: '2026-09-20T10:00:00.000Z',
      status: { type: 'idle' },
      ...(index === 14
        ? { project: { kind: 'github', repoFullName: 'synthetic/other', branch: 'main' } }
        : {}),
    } as SessionMeta;
  }
  store.set(sessionMetaCacheAtom, sessions);
  return store;
}

const styles = stylex.create({
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  fixture: { width: 800, maxWidth: 'calc(100vw - 64px)', paddingTop: 180 },
  caption: { marginTop: 24, fontSize: 14 },
});

function SessionSearchComposer() {
  const [store] = useState(createSessionSearchStore);
  const [prompt, setPrompt] = useState('');
  return (
    <SettingsStoryProviders>
      <Provider store={store}>
        <div {...stylex.props(styles.page)}>
          <div {...stylex.props(styles.fixture)}>
            <ChatComposer
              variant="landing"
              tone="light"
              promptValue={prompt}
              onPromptChange={setPrompt}
              promptRows={3}
              attachmentAddDisabled
              primaryAction={<Button disabled>Send</Button>}
            />
            <p {...stylex.props(styles.caption)}>
              Local synthetic fixture · 14 No project sessions · 1 session in another project
            </p>
          </div>
        </div>
      </Provider>
    </SettingsStoryProviders>
  );
}

const meta = {
  title: 'Mentions/SessionMentionSearch',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;

export const NoProject: StoryObj<typeof meta> = { render: () => <SessionSearchComposer /> };
