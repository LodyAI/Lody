import { useCallback, useMemo, useRef, useState } from 'react';
import {
  buildStatusViewLayout,
  flattenStatusViewRows,
  planStatusViewCommand,
  statusViewPinnedIds,
  type PinSection,
  type StatusViewCommand,
  type StatusViewLayoutInput,
  type StatusViewSession,
  type StatusViewState,
  type StatusViewWrite,
} from '@lody/shared';
import type {
  SidebarPinSectionActions,
  SidebarPinnedSection,
} from '@/components/sidebar-pinned-sections';
import type { SidebarUpdatedItem } from '@/components/sidebar-updated-session-list';
import {
  focusDropBeforeId,
  pinnedDropBeforeId,
  sectionDropBeforeId,
} from '@/lib/status-view-state';

/** A demo conversation: the metadata the Status view reads, plus what the row shows. */
export type StoryConversation = {
  id: string;
  title: string;
  latestMessageAt: number;
  isPinned: boolean;
  pinSectionId?: string;
  orderKey?: string;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
  snoozedUntil?: number;
  settledAt?: number;
  focusRestoredAt?: number;
};

const toStatusViewSession = (conversation: StoryConversation): StatusViewSession => ({
  id: conversation.id,
  title: conversation.title,
  lastMessageAt: conversation.latestMessageAt,
  lastReadAt: conversation.hasUnreadMessages ? null : conversation.latestMessageAt,
  isPinned: conversation.isPinned,
  pinSectionId: conversation.pinSectionId ?? null,
  orderKey: conversation.orderKey ?? null,
  snoozedUntil: conversation.snoozedUntil ?? null,
  settledAt: conversation.settledAt ?? null,
  focusRestoredAt: conversation.focusRestoredAt ?? null,
  openedById: null,
  isWorking: Boolean(conversation.isWorking),
  isWaitingPermission: Boolean(conversation.isWaitingPermission),
  canManage: true,
  canPrefer: true,
});

const randomByte = () => Math.floor(Math.random() * 256);

/**
 * Story state that lays out and plans with the same shared Status view and the
 * same drop-to-neighbor resolution as the desktop sidebar; only the Repo write
 * is replaced by local state.
 */
export function useStatusViewStoryState<T extends StoryConversation>(
  initialConversations: readonly T[],
  initialSections: readonly PinSection[],
  toItem: (conversation: T) => SidebarUpdatedItem
) {
  const [conversations, setConversations] = useState<T[]>(() => [...initialConversations]);
  const [sections, setSections] = useState<PinSection[]>(() => [...initialSections]);

  const input = useMemo<StatusViewLayoutInput>(
    () => ({
      sessions: conversations.map(toStatusViewSession),
      sections,
      sectionsLoaded: true,
      canManageSections: true,
      nowMs: Date.now(),
    }),
    [conversations, sections]
  );
  const layout = useMemo(() => buildStatusViewLayout(input), [input]);
  const inputRef = useRef(input);
  inputRef.current = input;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const apply = useCallback((writes: readonly StatusViewWrite[]) => {
    const patches = new Map<string, Record<string, unknown>>();
    for (const write of writes) {
      if (write.type !== 'session') continue;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(write.patch)) {
        patch[key] = value === null ? undefined : value;
      }
      patches.set(write.sessionId, { ...patches.get(write.sessionId), ...patch });
    }
    if (patches.size > 0) {
      setConversations((previous) =>
        previous.map((entry) => {
          const patch = patches.get(entry.id);
          return patch ? { ...entry, ...patch } : entry;
        })
      );
    }
    for (const write of writes) {
      if (write.type === 'putSection') {
        setSections((previous) => [
          ...previous.filter((section) => section.id !== write.section.id),
          write.section,
        ]);
      } else if (write.type === 'deleteSection') {
        setSections((previous) => previous.filter((section) => section.id !== write.sectionId));
      }
    }
  }, []);

  const run = useCallback(
    (command: StatusViewCommand, state: StatusViewState = inputRef.current) => {
      const writes = planStatusViewCommand(state, command, { nowMs: Date.now(), randomByte });
      apply(writes);
      return writes;
    },
    [apply]
  );

  const byId = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations]
  );
  const pinnedSections = useMemo<SidebarPinnedSection[]>(
    () =>
      layout.pinned.map((entry) => ({
        id: entry.sectionId,
        name: entry.name ?? '',
        items: flattenStatusViewRows(entry.rows).flatMap((row) => {
          const conversation = byId.get(row.id);
          return conversation ? [toItem(conversation)] : [];
        }),
      })),
    [byId, layout, toItem]
  );
  const updatedItems = useMemo(() => {
    const pinnedIds = statusViewPinnedIds(input.sessions);
    return conversations.filter((entry) => !pinnedIds.has(entry.id)).map(toItem);
  }, [conversations, input, toItem]);

  const pinSectionActions = useMemo<SidebarPinSectionActions>(
    () => ({
      onDropItem: (itemId, sectionId, toIndex) => {
        run({
          type: 'move',
          sessionId: itemId,
          to: { area: 'pinned', sectionId },
          beforeId: pinnedDropBeforeId(
            layoutRef.current,
            inputRef.current.sessions,
            sectionId,
            itemId,
            toIndex
          ),
        });
      },
      onMoveSection: (sectionId, toIndex) => {
        run({
          type: 'moveSection',
          sectionId,
          beforeId: sectionDropBeforeId(layoutRef.current, sectionId, toIndex),
        });
      },
      onCreateSection: (name, moveItemId) => {
        const created = run({ type: 'createSection', sectionId: `sec-${Date.now()}`, name }).find(
          (write) => write.type === 'putSection'
        )?.section;
        if (!moveItemId || !created) return;
        const base = inputRef.current;
        run(
          {
            type: 'move',
            sessionId: moveItemId,
            to: { area: 'pinned', sectionId: created.id },
            beforeId: null,
          },
          { ...base, sections: [...base.sections, created] }
        );
      },
      onRenameSection: (sectionId, name) => {
        run({ type: 'renameSection', sectionId, name });
      },
      onDeleteSection: (sectionId) => {
        run({ type: 'deleteSection', sectionId });
      },
    }),
    [run]
  );

  const onDropFocusItem = useCallback(
    (sessionId: string, toIndex: number) => {
      run({
        type: 'move',
        sessionId,
        to: { area: 'focus' },
        beforeId: focusDropBeforeId(layoutRef.current, sessionId, toIndex),
      });
    },
    [run]
  );

  return {
    conversations,
    setConversations,
    pinnedSections,
    updatedItems,
    pinSectionActions,
    onDropFocusItem,
    togglePin: (sessionId: string, pinned: boolean) =>
      run({ type: 'setPinned', sessionId, pinned }),
    snooze: (sessionId: string, until: number) =>
      run({ type: 'snooze', sessionId, until, includeOpened: false }),
    settle: (sessionId: string) => run({ type: 'settle', sessionId, includeOpened: false }),
    moveToFocus: (sessionId: string) =>
      run({ type: 'moveToFocus', sessionId, includeOpened: false }),
  };
}
