// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore } from 'jotai';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory, SessionMeta } from '@lody/shared';
import en from '../../../locales/en.json';
import { userAtom } from '../src/atoms';
import { localMachineIdAtom } from '../src/atoms/local-probe';
import { runtimeAtom } from '../src/atoms/runtime';
import { SessionLimitContinueAction } from '../src/components/schedules/quota-continue-action';
import {
  findClaudeSessionLimit,
  isClaudeSessionLimitMessage,
} from '../src/components/schedules/quota-continue';

const state = vi.hoisted(() => ({
  turns: [] as SessionHistory[],
  enabled: false,
  setTweak: vi.fn(),
}));
vi.mock('../src/components/sessions/use-local-session-continuation', () => ({
  useLocalSessionContinuation: () => ({
    recoveryEnabled: state.enabled,
    busy: false,
    setTweak: state.setTweak,
  }),
}));
vi.mock('../src/atoms/local-probe', async () => {
  const { atom } = await import('jotai');
  return { localMachineIdAtom: atom<string | null>(null) };
});
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ enabled: true, workspaceId: 'workspace' }),
}));
vi.mock('../src/hooks/use-session-doc', () => ({ useSessionDoc: () => ({ history: null }) }));
vi.mock('../src/hooks/use-conversation-view', () => ({
  useConversationTail: () => ({ turns: state.turns }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const session = {
  id: 'session',
  userId: 'owner',
  machineId: 'machine',
  agentType: 'claude',
} as SessionMeta;
const user = {
  id: 'user-turn',
  role: 'user',
  timestamp: '2026-10-27T14:00:00Z',
  items: [{ type: 'text', text: 'task' }],
  inputConfig: { agentType: 'claude' },
} as SessionHistory;
const failure = {
  id: 'failure',
  role: 'system',
  timestamp: '2026-10-27T14:01:00Z',
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: { message: "You've hit your session limit · resets 2:30pm (UTC)" },
    },
  ],
} as SessionHistory;

describe('Claude quota recovery action', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } });
  });
  beforeEach(() => {
    state.turns = [user, failure];
    state.enabled = false;
    state.setTweak.mockReset();
    getDefaultStore().set(userAtom, { id: 'owner' } as never);
    getDefaultStore().set(localMachineIdAtom, 'machine' as never);
    getDefaultStore().set(runtimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'plaintext',
    } as never);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    getDefaultStore().set(runtimeAtom, null);
  });
  const render = async (entryId = 'failure') => {
    await act(async () =>
      root.render(<SessionLimitContinueAction session={{ ...session }} entryId={entryId} />)
    );
  };
  it('enables the Session setting from the current failure', async () => {
    await render();
    expect(container.textContent).toContain('Enable automatic recovery');
    await act(async () => container.querySelector('button')!.click());
    expect(state.setTweak).toHaveBeenCalledWith('recoverCapacity', true);
    state.enabled = true;
    await render();
    expect(container.textContent).toContain('Automatic capacity recovery is enabled');
    expect(container.querySelector('button')).toBeNull();
  });
  it('does not offer recovery on an old failure or after a new user input', async () => {
    await render('older');
    expect(container.textContent).toBe('');
    state.turns = [user, failure, { ...user, id: 'new-user' }];
    await render();
    expect(container.textContent).toBe('');
  });
  it('does not interpret user prose or unrelated errors as a quota failure', () => {
    expect(findClaudeSessionLimit([{ ...user, items: failure.items }])).toBeNull();
    expect(isClaudeSessionLimitMessage('HTTP 429: rate limited')).toBe(false);
    expect(isClaudeSessionLimitMessage("You've hit your weekly limit · resets Friday")).toBe(false);
  });
  it('places a folded failure on its assistant row', () => {
    const assistant = {
      ...user,
      id: 'assistant',
      role: 'assistant',
      items: [{ type: 'text', text: 'partial' }],
    } as SessionHistory;
    expect(findClaudeSessionLimit([user, assistant, failure])?.noticeId).toBe('assistant');
  });
});
