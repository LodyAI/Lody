import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useMemo, useState } from 'react';
import {
  buildPinnedSectionLayout,
  planNewPinPlacement,
  planNewPinSectionOrderKey,
  planPinSectionMove,
  planPinnedSessionMove,
  type PinPlacementWrite,
  type PinSection,
  type PinnedSessionPlacement,
} from '@lody/shared';
import { LoroSidebar } from '@/components/loro-sidebar';
import { SessionMentionDropLayer } from '@/components/sessions/session-mention-drop-layer';
import type { SidebarPinSectionActions } from '@/components/sidebar-pinned-sections';
import type { SidebarUpdatedItem } from '@/components/sidebar-updated-session-list';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

type DemoConversation = {
  id: string;
  title: string;
  latestMessageAt: number;
  isPinned: boolean;
  pinSectionId?: string;
  orderKey?: string;
};

const INITIAL_SECTIONS: PinSection[] = [
  { id: 'maintenance', name: 'Maintenance', orderKey: '80' },
  { id: 'releases', name: 'Releases', orderKey: '81' },
];

const INITIAL_CONVERSATIONS: DemoConversation[] = [
  {
    id: 'c1',
    title: 'Triage today’s inbox',
    latestMessageAt: NOW - HOUR,
    isPinned: true,
    orderKey: '80',
  },
  {
    id: 'c2',
    title: 'Fix login form reset',
    latestMessageAt: NOW - 3 * HOUR,
    isPinned: true,
    orderKey: '81',
  },
  {
    id: 'c3',
    title: 'Weekly mirror update check',
    latestMessageAt: NOW - 50 * HOUR,
    isPinned: true,
    pinSectionId: 'maintenance',
    orderKey: '80',
  },
  {
    id: 'c4',
    title: 'Bump dependencies',
    latestMessageAt: NOW - 2 * HOUR,
    isPinned: true,
    pinSectionId: 'maintenance',
    orderKey: '81',
  },
  {
    id: 'c5',
    title: 'Rotate staging secrets',
    latestMessageAt: NOW - 30 * HOUR,
    isPinned: true,
    pinSectionId: 'maintenance',
    orderKey: '82',
  },
  {
    id: 'c6',
    title: 'Draft 0.105 release notes',
    latestMessageAt: NOW - 5 * HOUR,
    isPinned: true,
    pinSectionId: 'releases',
    orderKey: '80',
  },
  // Pinned extras so the pinned area itself overflows too.
  ...Array.from({ length: 16 }, (_, index) => ({
    id: `pinned-extra-${index + 1}`,
    title: `Pinned thread ${index + 1}`,
    latestMessageAt: NOW - (index + 1) * 40 * 60 * 1000,
    isPinned: true,
    pinSectionId: index % 2 === 0 ? 'maintenance' : 'releases',
    orderKey: `${90 + index}`,
  })),
  {
    id: 'c7',
    title: 'Investigate flaky CI job',
    latestMessageAt: NOW - 20 * 60 * 1000,
    isPinned: false,
  },
  { id: 'c8', title: 'Review onboarding copy', latestMessageAt: NOW - 4 * HOUR, isPinned: false },
  { id: 'c9', title: 'Plan Q1 roadmap', latestMessageAt: NOW - 26 * HOUR, isPinned: false },
  // Enough rows to overflow the viewport: drag one toward the top edge and the
  // list auto-scrolls up to the pin sections.
  ...Array.from({ length: 80 }, (_, index) => ({
    id: `extra-${index + 1}`,
    title: `Follow-up thread ${index + 1}`,
    latestMessageAt: NOW - (30 + index) * HOUR,
    isPinned: false,
  })),
];

const toItem = (conversation: DemoConversation): SidebarUpdatedItem => ({
  id: conversation.id,
  kind: 'chat',
  title: conversation.title,
  sectionLabel: 'Chats',
  subtitle: null,
  latestMessageAt: new Date(conversation.latestMessageAt),
  isPinned: conversation.isPinned,
});

const toPlacement = (conversation: DemoConversation): PinnedSessionPlacement => ({
  id: conversation.id,
  pinSectionId: conversation.pinSectionId ?? null,
  orderKey: conversation.orderKey ?? null,
  recency: conversation.latestMessageAt,
});

/**
 * Interactive pin sections. State lives in the story, but every key comes from
 * the same planners the app uses, so drags and menu moves behave as in the app.
 */
function PinnedSectionsPlayground() {
  const [conversations, setConversations] = useState(INITIAL_CONVERSATIONS);
  const [sections, setSections] = useState(INITIAL_SECTIONS);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [defaultCollapsed, setDefaultCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>('c3');
  const [mentioned, setMentioned] = useState<string | null>(null);

  const pinned = useMemo(() => conversations.filter((entry) => entry.isPinned), [conversations]);
  const layout = useMemo(
    () => buildPinnedSectionLayout(pinned, sections, toPlacement),
    [pinned, sections]
  );
  const pinnedSections = useMemo(
    () =>
      layout.map((entry) => ({
        id: entry.sectionId,
        name: entry.section?.name ?? '',
        items: entry.items.map(toItem),
      })),
    [layout]
  );
  const pinnedItems = useMemo(() => pinned.map(toItem), [pinned]);
  const updatedItems = useMemo(
    () => conversations.filter((entry) => !entry.isPinned).map(toItem),
    [conversations]
  );

  const apply = useCallback((writes: readonly PinPlacementWrite[]) => {
    const byId = new Map(writes.map((write) => [write.sessionId, write]));
    setConversations((previous) =>
      previous.map((entry) => {
        const write = byId.get(entry.id);
        return write
          ? {
              ...entry,
              isPinned: true,
              pinSectionId: write.pinSectionId,
              orderKey: write.orderKey,
            }
          : entry;
      })
    );
  }, []);

  const plan = useCallback(
    (itemId: string, toSectionId: string | null, toIndex: number, nextSections = sections) =>
      planPinnedSessionMove(
        buildPinnedSectionLayout(pinned.map(toPlacement), nextSections, (entry) => entry),
        { sessionId: itemId, toSectionId, toIndex }
      ),
    [pinned, sections]
  );

  const actions = useMemo<SidebarPinSectionActions>(
    () => ({
      onDropItem: (itemId, sectionId, toIndex) => apply(plan(itemId, sectionId, toIndex)),
      onMoveSection: (sectionId, toIndex) =>
        setSections((previous) =>
          previous.map((entry) =>
            entry.id === sectionId
              ? { ...entry, orderKey: planPinSectionMove(previous, sectionId, toIndex) }
              : entry
          )
        ),
      onCreateSection: (name, moveItemId) => {
        const section: PinSection = {
          id: `section-${Math.random().toString(36).slice(2, 8)}`,
          name,
          orderKey: planNewPinSectionOrderKey(sections),
        };
        const nextSections = [...sections, section];
        setSections(nextSections);
        if (moveItemId) apply(plan(moveItemId, section.id, 0, nextSections));
      },
      onRenameSection: (sectionId, name) =>
        setSections((previous) =>
          previous.map((entry) => (entry.id === sectionId ? { ...entry, name } : entry))
        ),
      onDeleteSection: (sectionId) =>
        setSections((previous) => previous.filter((entry) => entry.id !== sectionId)),
    }),
    [apply, plan, sections]
  );

  const togglePinned = useCallback(
    (itemId: string, nextPinned: boolean) => {
      if (!nextPinned) {
        setConversations((previous) =>
          previous.map((entry) =>
            entry.id === itemId
              ? { ...entry, isPinned: false, pinSectionId: undefined, orderKey: undefined }
              : entry
          )
        );
        return;
      }
      const defaultPins = pinned.filter((entry) => !entry.pinSectionId).map(toPlacement);
      const { orderKey } = planNewPinPlacement(
        buildPinnedSectionLayout(defaultPins, [], (entry) => entry)
      );
      setConversations((previous) =>
        previous.map((entry) =>
          entry.id === itemId
            ? { ...entry, isPinned: true, pinSectionId: undefined, orderKey }
            : entry
        )
      );
    },
    [pinned]
  );

  return (
    <div className="flex h-screen bg-sidebar">
      <div className="h-full w-[280px] shrink-0">
        <LoroSidebar
          workspaceName="Loro"
          userEmail="demo@example.com"
          workspaces={[{ id: 'ws-1', name: 'Loro' }]}
          currentWorkspaceId="ws-1"
          repoSections={[]}
          chats={[]}
          organizeMode="updated"
          pinnedItems={pinnedItems}
          pinnedSections={pinnedSections}
          pinnedSectionCollapsed={defaultCollapsed}
          onTogglePinnedSection={() => setDefaultCollapsed((previous) => !previous)}
          collapsedPinSectionIds={collapsed}
          onTogglePinSection={(sectionId) =>
            setCollapsed((previous) => ({ ...previous, [sectionId]: !previous[sectionId] }))
          }
          pinSectionActions={actions}
          updatedItems={updatedItems}
          updatedSelectedItemId={selected}
          onSelectUpdatedItem={setSelected}
          onToggleUpdatedItemPinned={togglePinned}
          onArchiveUpdatedItem={(itemId) =>
            setConversations((previous) => previous.filter((entry) => entry.id !== itemId))
          }
        />
      </div>
      <SessionMentionDropLayer
        enabled
        className="flex-1"
        onDropSessionId={(sessionId) =>
          setMentioned(conversations.find((entry) => entry.id === sessionId)?.title ?? sessionId)
        }
      >
        <div className="p-6 text-sm text-muted-foreground" data-story-mention-target="">
          <p>Drag conversations between rows and onto section headers.</p>
          <p>Hold a dragged conversation near the top or bottom edge to auto-scroll.</p>
          <p>Drag a section header to reorder sections.</p>
          <p>Right-click a pinned conversation for “Move to Section” and “New Section…”.</p>
          <p>Use a section header’s ⋯ menu to rename or delete it.</p>
          <p className="mt-4">
            Drop a conversation on this pane to mention it, as on a conversation.
          </p>
          <p className="mt-2 text-foreground" data-story-mentioned="">
            {mentioned ? `Mentioned: ${mentioned}` : 'Nothing mentioned yet'}
          </p>
        </div>
      </SessionMentionDropLayer>
    </div>
  );
}

/**
 * "My Tasks" scope: Maintenance holds only teammates' conversations, and the
 * default section hides one more. Both say what the view hides instead of
 * rendering a bare header.
 */
function HiddenByScopeDemo() {
  const [selected, setSelected] = useState<string | null>('c1');
  // What the scope leaves visible: c3/c4/c5 (maintenance) and one default row
  // are filtered out before the pinned area is built.
  const visiblePinned = useMemo(
    () => INITIAL_CONVERSATIONS.filter((entry) => ['c1', 'c2', 'c6'].includes(entry.id)),
    []
  );
  const layout = useMemo(
    () => buildPinnedSectionLayout(visiblePinned, INITIAL_SECTIONS, toPlacement),
    [visiblePinned]
  );
  const pinnedSections = useMemo(
    () =>
      layout.map((entry) => ({
        id: entry.sectionId,
        name: entry.section?.name ?? '',
        items: entry.items.map(toItem),
      })),
    [layout]
  );
  const pinnedItems = useMemo(() => visiblePinned.map(toItem), [visiblePinned]);

  return (
    <div className="flex h-screen bg-sidebar">
      <div className="h-full w-[280px] shrink-0">
        <LoroSidebar
          workspaceName="Loro"
          userEmail="demo@example.com"
          workspaces={[{ id: 'ws-1', name: 'Loro' }]}
          currentWorkspaceId="ws-1"
          repoSections={[]}
          chats={[]}
          organizeMode="updated"
          pinnedItems={pinnedItems}
          pinnedSections={pinnedSections}
          pinnedHiddenCounts={{ default: 1, maintenance: 3 }}
          updatedItems={[]}
          updatedSelectedItemId={selected}
          onSelectUpdatedItem={setSelected}
        />
      </div>
      <div className="flex-1 p-6 text-sm text-muted-foreground">
        <p>Maintenance renders its header and names the rows this view hides.</p>
        <p>The default section keeps its visible rows and reports the rest.</p>
        <p>A folded section hides the hint; its header already implies content.</p>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sidebar/Pinned Sections',
  component: PinnedSectionsPlayground,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PinnedSectionsPlayground>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const HiddenByScope: Story = {
  render: () => <HiddenByScopeDemo />,
};
