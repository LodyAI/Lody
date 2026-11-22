import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore, useStore } from 'jotai';
import { LoroDoc } from 'loro-crdt';
import { useEffect, useMemo, useState } from 'react';
import {
  getSessionRoomId,
  getTodayDocId,
  openTodayOutline,
  parseTodayPasteText,
  TODAY_MENTION_CHAR,
  type LodyPresenceStateMap,
  type SessionId,
  type SessionMeta,
  type TodayDate,
  type TodayFragment,
  type TodayMention,
} from '@lody/shared';
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import type { SessionMentionItem } from '@/components/mentions/mention-session-source';
import { todayMentionMarkdown } from '@/components/today/editor/block-selection';
import { TodayEditorContext } from '@/components/today/editor/today-editor-context';
import { TodayEditorController } from '@/components/today/editor/today-editor-controller';
import { TodayDaySection } from '@/components/today/today-day-section';
import {
  TodayNodeActions,
  TodayOutlineSurface,
  type TodayConvertDialogComponent,
} from '@/components/today/today-view';
import { TodaySessionPicker } from '@/components/today/today-mention-picker';
import { TodayMembersContext } from '@/components/today/today-members';
import type { WorkspaceMember } from '@/hooks/use-workspace-members';
import {
  TodayMentionStatusMenu,
  type TodayMentionStatusActions,
} from '@/components/today/today-mention-status-menu';
import { createTodayPageStoreCache } from '@/providers/today-page-store-cache';
import { ConvertDialogPreview } from './fixtures/convert-dialog';

/**
 * Today with conversations, entirely synthetic: mentions sit inline in
 * sentences and show every status, the status icon's menu changes the seeded
 * metadata, `@` anywhere offers these conversations, and the bullet menu's
 * "Convert to task" opens the dialog's real layout over fixture selectors (the
 * product wraps the stateful landing, which needs a workspace runtime).
 */
const USER = 'demo-user';
const TODAY = '2026-11-20' as TodayDate;
const NOW = Date.now();
const MINUTE = 60_000;

type DemoSession = {
  id: string;
  title: string;
  meta: Partial<SessionMeta> & Record<string, unknown>;
};
const SESSIONS: DemoSession[] = [
  {
    id: 'demo-running',
    title: 'Fix the flaky sync test',
    meta: { lastMessageAt: NOW - MINUTE, lastReadAt: NOW },
  },
  {
    id: 'demo-waiting',
    title: 'Upgrade Electron to 44',
    meta: { lastMessageAt: NOW - 5 * MINUTE, lastReadAt: NOW },
  },
  {
    id: 'demo-unread',
    title: 'Review the release notes',
    meta: { lastMessageAt: NOW - 2 * MINUTE, lastReadAt: NOW - 30 * MINUTE },
  },
  {
    id: 'demo-read',
    title: 'Answer the plugin question',
    meta: { lastMessageAt: NOW - 20 * MINUTE, lastReadAt: NOW - 10 * MINUTE },
  },
  {
    id: 'demo-later',
    title: 'Benchmark the new store',
    meta: { lastMessageAt: NOW - 40 * MINUTE, lastReadAt: NOW, snoozedUntil: NOW + 125 * MINUTE },
  },
  {
    id: 'demo-settled',
    title: 'Rename the CLI flag',
    meta: { lastMessageAt: NOW - 60 * MINUTE, settledAt: NOW - 30 * MINUTE },
  },
  {
    id: 'demo-archived',
    title: 'Old migration spike',
    meta: { lastMessageAt: NOW - 600 * MINUTE, isArchived: true },
  },
  {
    id: 'demo-idle',
    title: 'Draft the weekly update',
    meta: { lastMessageAt: NOW - 90 * MINUTE, lastReadAt: NOW },
  },
];

/** One node: strings are text, `{ m: id }` a mention of that conversation. */
const line = (...parts: Array<string | { m: string }>): TodayFragment => {
  let text = '';
  const mentions: TodayMention[] = [];
  for (const part of parts) {
    if (typeof part === 'string') text += part;
    else {
      mentions.push({ start: text.length, kind: 'session', id: part.m });
      text += TODAY_MENTION_CHAR;
    }
  }
  return { text, mentions, children: [] };
};
const face = (fill: string, skin: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="${fill}"/><circle cx="20" cy="16" r="7" fill="${skin}"/><path d="M6 40c2-9 8-13 14-13s12 4 14 13z" fill="${skin}"/></svg>`
  )}`;
const MEMBERS: WorkspaceMember[] = [
  { userId: USER, name: 'Sam Lee', image: face('#c7d2fe', '#f5d0b0') },
  { userId: 'member-ava', name: 'Ava Chen', image: face('#fde68a', '#e8b48f') },
  { userId: 'member-noah', name: 'Noah Park', image: face('#bbf7d0', '#d9a37c') },
  { userId: 'member-mia', name: 'Mia Rossi' },
];
const MEMBERS_BY_ID = new Map(MEMBERS.map((member) => [member.userId, member] as const));

const PAGE: TodayFragment[] = [
  line('Morning: ', { m: 'demo-running' }, ' should land before standup'),
  line('Approve ', { m: 'demo-waiting' }, ' once CI is green'),
  line({ m: 'demo-unread' }, ' has news, and ', { m: 'demo-read' }, ' is answered'),
  line('Back on ', { m: 'demo-later' }, ' after lunch'),
  line('Done: ', { m: 'demo-settled' }, ', ', { m: 'demo-archived' }),
  line({ m: 'demo-idle' }),
  {
    text: `Pair with ${TODAY_MENTION_CHAR} on the sync review`,
    mentions: [{ start: 10, kind: 'member', id: 'member-ava' }],
    children: [],
  },
  ...parseTodayPasteText(
    'Prompt for later\n  Make Today remember the last calendar month\n  Keep the change small'
  ),
  ...parseTodayPasteText('- [ ] Reply to the plugin thread\n- [x] Book the review slot'),
  { text: '', children: [] },
  ...parseTodayPasteText('After the blank line'),
];

function seedStore() {
  const store = createStore();
  const metas: Record<string, SessionMeta> = {};
  for (const demo of SESSIONS) {
    metas[getSessionRoomId(demo.id as SessionId)] = {
      id: demo.id,
      title: demo.title,
      createdAt: NOW - 1000 * MINUTE,
      ...demo.meta,
    } as unknown as SessionMeta;
  }
  store.set(sessionMetaCacheAtom, metas);
  store.set(docMetaCacheReadyAtom, true);
  const presence: LodyPresenceStateMap = {
    running: {
      kind: 'session',
      sessionId: 'demo-running' as SessionId,
      machineId: 'm' as never,
      instanceId: 'i' as never,
      status: { type: 'running' },
      updatedAt: NOW,
    },
    waiting: {
      kind: 'session',
      sessionId: 'demo-waiting' as SessionId,
      machineId: 'm' as never,
      instanceId: 'i' as never,
      status: { type: 'requestPermission' },
      updatedAt: NOW,
    },
  };
  store.set(lodyPresenceStatesAtom, presence);
  store.set(lodyPresenceNowMsAtom, NOW);
  return store;
}

/**
 * The real dialog layout (header, `ChatLandingView` dialog layout, desktop
 * selectors) over fixtures; "Start task" creates a demo conversation, which
 * the node then mentions.
 */
const DemoConvertDialog: TodayConvertDialogComponent = ({
  open,
  prompt,
  onAccepted,
  onOpenChange,
}) => {
  const store = useStore();
  return (
    <ConvertDialogPreview
      open={open}
      prompt={prompt}
      onOpenChange={onOpenChange}
      onStart={(text) => {
        const id = `demo-new-${Date.now()}` as SessionId;
        store.set(sessionMetaCacheAtom, (previous) => ({
          ...previous,
          [getSessionRoomId(id)]: {
            id,
            title: text.trim().split('\n')[0] || 'New task',
            createdAt: Date.now(),
            lastMessageAt: Date.now(),
            lastReadAt: Date.now(),
          } as unknown as SessionMeta,
        }));
        store.set(lodyPresenceStatesAtom, (previous) => ({
          ...previous,
          [id]: {
            kind: 'session',
            sessionId: id,
            machineId: 'm' as never,
            instanceId: 'i' as never,
            status: { type: 'running' },
            updatedAt: Date.now(),
          },
        }));
        store.set(lodyPresenceNowMsAtom, Date.now());
        onAccepted(id);
        onOpenChange(false);
      }}
    />
  );
};

function TodayWithConversations() {
  const store = useMemo(seedStore, []);
  return (
    <Provider store={store}>
      <Surface />
    </Provider>
  );
}

function Surface() {
  const cache = useMemo(
    () =>
      createTodayPageStoreCache({
        releaseDelayMs: 60_000,
        idleCap: 4,
        retryDelayMs: () => 1_000,
        setTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        repo: {
          openDoc: async () => {
            const doc = new LoroDoc();
            openTodayOutline(doc).paste({ kind: 'page-start' }, PAGE);
            return {
              doc,
              joinRoom: async () => ({
                room: { unsubscribe: () => {} },
                synced: Promise.resolve(),
              }),
            };
          },
          isRegistered: async () => true,
          upsertDocMeta: async () => {},
          unloadDoc: async () => {},
          observeDocs: () => ({ docIds: [getTodayDocId(USER, TODAY)], unsubscribe: () => {} }),
        },
      }),
    []
  );
  const jotai = useStore();
  // The product writes session metadata through useSessionActions; here the
  // same edits land in the seeded metadata cache.
  const actions = useMemo<TodayMentionStatusActions>(() => {
    const patch = (id: SessionId, change: Record<string, unknown>) =>
      jotai.set(sessionMetaCacheAtom, (previous) => {
        const key = getSessionRoomId(id);
        return { ...previous, [key]: { ...previous[key], ...change } as SessionMeta };
      });
    return {
      markRead: (id, lastMessageAt) => patch(id, { lastReadAt: lastMessageAt ?? Date.now() }),
      markUnread: (id) => patch(id, { lastReadAt: 0 }),
      snooze: (id, until) => patch(id, { snoozedUntil: until, settledAt: undefined }),
      settle: (id) => patch(id, { settledAt: Date.now(), snoozedUntil: undefined }),
      moveToFocus: (id) =>
        patch(id, { snoozedUntil: undefined, settledAt: undefined, focusRestoredAt: Date.now() }),
    };
  }, [jotai]);
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    created.onOpenSession = (sessionId) => window.alert(`Open conversation ${sessionId}`);
    created.onOpenMember = (userId) => window.alert(`Open ${userId}'s Today`);
    created.workspaceId = 'demo-workspace';
    created.mentionText = (mention) =>
      todayMentionMarkdown(mention, {
        workspaceId: 'demo-workspace',
        title:
          mention.kind === 'member'
            ? MEMBERS_BY_ID.get(mention.id)?.name
            : SESSIONS.find((demo) => demo.id === mention.id)?.title,
      });
    setController(created);
    return () => created.dispose();
  }, [cache]);
  const items: SessionMentionItem[] = SESSIONS.filter((demo) => !demo.meta.isArchived).map(
    (demo, index) => ({
      slug: demo.id,
      sessionId: demo.id as SessionId,
      title: demo.title,
      activityAt: NOW - index * MINUTE,
      projectKey: 'chat',
    })
  );
  return (
    <TodayEditorContext.Provider value={controller}>
      <TodayMembersContext.Provider value={MEMBERS_BY_ID}>
        <div style={{ maxWidth: 720, height: 640, display: 'flex', flexDirection: 'column' }}>
          <TodayOutlineSurface controller={controller}>
            <TodayDaySection
              cache={cache}
              userId={USER}
              date={TODAY}
              today={TODAY}
              isTop
              onEmptyChange={() => {}}
            />
          </TodayOutlineSurface>
          <TodaySessionPicker items={items} />
          <TodayNodeActions pinned={false} ConvertDialog={DemoConvertDialog} />
          <TodayMentionStatusMenu actions={actions} />
        </div>
      </TodayMembersContext.Provider>
    </TodayEditorContext.Provider>
  );
}

const meta: Meta<typeof TodayWithConversations> = {
  title: 'Today/With conversations',
  component: TodayWithConversations,
};
export default meta;

export const Default: StoryObj<typeof TodayWithConversations> = {};

/** The "Convert to task" dialog on its own, opened over a node's text. */
function ConvertDialogAlone() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConvertDialogPreview
        open={open}
        prompt={'Plan the launch\n  Draft the release notes\n  Ping design about the hero image'}
        onOpenChange={setOpen}
        onStart={() => setOpen(false)}
      />
    </>
  );
}

export const ConvertDialogLight: StoryObj<typeof TodayWithConversations> = {
  render: () => <ConvertDialogAlone />,
  globals: { theme: 'light' },
};

export const ConvertDialogDark: StoryObj<typeof TodayWithConversations> = {
  render: () => <ConvertDialogAlone />,
  globals: { theme: 'dark' },
};
