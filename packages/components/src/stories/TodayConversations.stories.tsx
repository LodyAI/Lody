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
} from '@lody/shared';
import { Button } from '@lody/ui/button';
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
  TodaySessionPicker,
  type TodayConvertDialogComponent,
} from '@/components/today/today-view';
import { createTodayPageStoreCache } from '@/providers/today-page-store-cache';

/**
 * Today with conversations, entirely synthetic: session nodes show live status,
 * `@` on an empty line offers these conversations, and the bullet menu's
 * "Convert to task" opens a stand-in dialog (the product uses the full
 * new-conversation surface, which needs a workspace runtime).
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

const session = (id: string): TodayFragment => ({
  text: TODAY_MENTION_CHAR,
  mentions: [{ start: 0, kind: 'session', id }],
  children: [],
});
const PAGE: TodayFragment[] = [
  ...parseTodayPasteText('In flight'),
  session('demo-running'),
  session('demo-waiting'),
  session('demo-unread'),
  ...parseTodayPasteText('Done'),
  session('demo-settled'),
  session('demo-archived'),
  ...parseTodayPasteText(
    'Prompt for later\n  Make Today remember the last calendar month\n  Keep the change small'
  ),
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

/** Stand-in for the new-conversation dialog: "Send" creates a demo conversation. */
const DemoConvertDialog: TodayConvertDialogComponent = ({
  open,
  prompt,
  onAccepted,
  onOpenChange,
}) => {
  const store = useStore();
  const [text, setText] = useState(prompt);
  useEffect(() => setText(prompt), [prompt]);
  if (!open) return null;
  return (
    <div
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'rgb(0 0 0 / 0.3)',
        zIndex: 60,
      }}
    >
      <div
        style={{
          width: 460,
          padding: 16,
          borderRadius: 12,
          background: 'white',
          display: 'grid',
          gap: 12,
        }}
      >
        <strong>Convert to task (Storybook stand-in)</strong>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          style={{ font: 'inherit', padding: 8 }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="small" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={() => {
              const id = `demo-new-${Date.now()}` as SessionId;
              store.set(sessionMetaCacheAtom, (previous) => ({
                ...previous,
                [getSessionRoomId(id)]: {
                  id,
                  title: text.split('\n')[0] || 'New task',
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
          >
            Send
          </Button>
        </div>
      </div>
    </div>
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
        setTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        repo: {
          openDoc: async () => {
            const doc = new LoroDoc();
            openTodayOutline(doc).paste({ kind: 'page-start' }, PAGE);
            return { doc, joinRoom: async () => ({ unsubscribe: () => {} }) };
          },
          isRegistered: async () => true,
          upsertDocMeta: async () => {},
          unloadDoc: async () => {},
          observeDocs: () => ({ docIds: [getTodayDocId(USER, TODAY)], unsubscribe: () => {} }),
        },
      }),
    []
  );
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    const created = new TodayEditorController(cache);
    created.onOpenSession = (sessionId) => window.alert(`Open conversation ${sessionId}`);
    created.mentionText = (mention) =>
      todayMentionMarkdown(mention, {
        workspaceId: 'demo-workspace',
        title: SESSIONS.find((demo) => demo.id === mention.id)?.title,
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
      <div style={{ maxWidth: 720, height: 640, display: 'flex', flexDirection: 'column' }}>
        <TodayOutlineSurface controller={controller}>
          <TodayDaySection
            cache={cache}
            userId={USER}
            date={TODAY}
            today={TODAY}
            isTop
            onEmpty={() => {}}
          />
        </TodayOutlineSurface>
        <TodaySessionPicker items={items} />
        <TodayNodeActions pinned={false} ConvertDialog={DemoConvertDialog} />
      </div>
    </TodayEditorContext.Provider>
  );
}

const meta: Meta<typeof TodayWithConversations> = {
  title: 'Today/With conversations',
  component: TodayWithConversations,
};
export default meta;

export const Default: StoryObj<typeof TodayWithConversations> = {};
