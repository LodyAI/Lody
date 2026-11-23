import { ScheduleMentionForm } from '../components/schedules/schedule-mention-form';
import { currentWorkspaceIdAtom, userAtom } from '../atoms';
import { sessionMetaCacheAtom } from '../atoms/doc-meta';
import { getSessionRoomId, type SessionMeta, type SessionId, type WorkspaceId } from '@lody/shared';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import type { StoryObj } from '@storybook/react-vite';
import type { MachineId } from '@lody/shared';
import { SettingsStoryProviders } from './settings-story-shell';
const NOW = Date.parse('2026-09-06T09:12:00+08:00');
export default { title: 'Workspace/ScheduleMentions', parameters: { layout: 'fullscreen' } };
function MentionEditorStory() {
  const [store] = useState(() => {
    const next = createStore();
    next.set(currentWorkspaceIdAtom, 'settings-story-workspace' as WorkspaceId);
    next.set(userAtom, { id: 'owner', name: 'Owner', email: 'fixture@example.invalid' });
    const id = 'schedule-reference-session' as SessionId;
    next.set(sessionMetaCacheAtom, {
      [getSessionRoomId(id)]: {
        id,
        machineId: 'machine' as MachineId,
        userId: 'owner',
        title: 'Review changes',
        createdAt: '2026-09-06T00:00:00Z',
        status: { type: 'idle' },
      } as SessionMeta,
    });
    return next;
  });
  const [saved, setSaved] = useState('');
  return (
    <SettingsStoryProviders>
      <Provider store={store}>
        <ScheduleMentionForm
          now={NOW}
          saving={false}
          timeZone="Asia/Shanghai"
          initial={{
            title: 'Daily review',
            prompt: '',
            trigger: { kind: 'manual' },
            misfire: 'skip',
            overlap: 'skip',
          }}
          onSave={(value) => setSaved(value.prompt)}
        />
        <output aria-label="Saved prompt">{saved}</output>
      </Provider>
    </SettingsStoryProviders>
  );
}

export const Editor: StoryObj = { render: () => <MentionEditorStory /> };
