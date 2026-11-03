import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import {
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type SessionId,
  type SessionMeta,
  getAgentConfigRoomId,
  getMachineRoomId,
} from '@lody/shared';
import { useMemo, useState } from 'react';

import { agentConfigMetaCacheAtom, machineMetaCacheAtom } from '@/atoms/doc-meta';
import {
  DraftSessionChatInterface,
  type DraftSessionSendPayload,
} from '@/components/sessions/draft-session-chat-interface';
import type { DraftSessionTab } from '@/lib/session-draft-tabs';
const storyLayout = stylex.create({
  frame: {
    height: '100vh',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

const machineId = 'machine-story' as MachineId;
const agentConfigId = 'agent-story' as AgentConfigId;
const sessionId = 'session-story' as SessionId;

const parentSession: SessionMeta = {
  id: sessionId,
  machineId,
  createdAt: '2026-03-27T00:00:00.000Z',
  title: 'Workspace Sync Investigation',
  userId: 'user-story',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
  agentConfigId,
  repoFullName: 'loro-dev/lody',
  project: {
    kind: 'github',
    repoFullName: 'loro-dev/lody',
    branch: 'main',
  },
  baseBranch: 'main',
};

const machineMeta: MachineViewMeta = {
  id: machineId,
  name: 'Storybook Mac Studio',
  cliVersion: '1.0.0',
  os: 'macOS',
  sessions: [sessionId],
  raceLimits: {},
};

const agentConfigMeta: AgentConfigMeta = {
  id: agentConfigId,
  machineId,
  name: 'Codex Primary',
  description: 'Storybook agent config',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

function StoryShell({ draft }: { draft: DraftSessionTab }) {
  const [currentDraft, setCurrentDraft] = useState(draft);
  const store = useMemo(() => {
    const next = createStore();
    next.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: machineMeta,
    });
    next.set(agentConfigMetaCacheAtom, {
      [getAgentConfigRoomId(agentConfigId)]: agentConfigMeta,
    });
    return next;
  }, []);

  const handleSendDraft = async (_payload: DraftSessionSendPayload) => true;

  return (
    <Provider store={store}>
      <div {...stylex.props(storyLayout.frame)}>
        <DraftSessionChatInterface
          draft={currentDraft}
          parentSession={parentSession}
          onDraftChange={(draftId, patch) => {
            setCurrentDraft((prev) => (prev.id === draftId ? { ...prev, ...patch } : prev));
          }}
          onSendDraft={handleSendDraft}
        />
      </div>
    </Provider>
  );
}

const baseDraft: DraftSessionTab = {
  id: 'draft:storybook' as DraftSessionTab['id'],
  sessionId: 'draft-session-storybook' as SessionId,
  prompt: '',
  agentConfigId,
  cliType: 'builtin',
  agentType: 'codex',
  modeId: null,
  modelId: null,
};

const meta = {
  title: 'Sessions/DraftSessionChatInterface',
  component: StoryShell,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyLight: Story = {
  args: {
    draft: baseDraft,
  },
  globals: {
    theme: 'light',
  },
};

export const PrefilledPrompt: Story = {
  args: {
    draft: {
      ...baseDraft,
      id: 'draft:storybook-prefilled' as DraftSessionTab['id'],
      sessionId: 'draft-session-storybook-prefilled' as SessionId,
      prompt: 'Audit the session bootstrap flow and call out race conditions.',
    },
  },
  globals: {
    theme: 'light',
  },
};

export const SuggestionsDark: Story = {
  args: {
    draft: {
      ...baseDraft,
      id: 'draft:storybook-dark' as DraftSessionTab['id'],
      sessionId: 'draft-session-storybook-dark' as SessionId,
    },
  },
  globals: {
    theme: 'dark',
  },
};
