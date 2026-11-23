import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import {
  buildPinnedSectionLayout,
  type PinSection,
  type PinnedSessionPlacement,
} from '@lody/shared';
import { LoroSidebar } from '@/components/loro-sidebar';
import { SessionMentionDropLayer } from '@/components/sessions/session-mention-drop-layer';
import type { SidebarUpdatedItem } from '@/components/sidebar-updated-session-list';
import { useStatusViewStoryState } from './status-view-story-state';

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
 * Interactive pin sections. State lives in the story, but layout, planning and
 * drop resolution are the app's own, so drags and menu moves behave as in the app.
 */
function PinnedSectionsPlayground({
  initialHidden = {},
}: {
  /** Sections hidden on this device, by `pinSectionKey`. */
  initialHidden?: Record<string, boolean>;
}) {
  const state = useStatusViewStoryState(INITIAL_CONVERSATIONS, INITIAL_SECTIONS, toItem);
  const { conversations, setConversations, pinnedSections, updatedItems } = state;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [defaultCollapsed, setDefaultCollapsed] = useState(false);
  const [hidden, setHidden] = useState<Record<string, boolean>>(initialHidden);
  const [selected, setSelected] = useState<string | null>('c3');
  const [mentioned, setMentioned] = useState<string | null>(null);
  const [newChatSection, setNewChatSection] = useState<string | null>(null);
  const pinnedItems = useMemo(
    () => conversations.filter((entry) => entry.isPinned).map(toItem),
    [conversations]
  );
  const pinSectionActions = useMemo(
    () => ({ ...state.pinSectionActions, onNewChat: setNewChatSection }),
    [state.pinSectionActions]
  );

  return (
    <div {...stylex.props(previewStyles.row)}>
      <div {...stylex.props(themeStyles.glyph)}>
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
          hiddenPinSectionKeys={hidden}
          onSetPinSectionHidden={(key, value) =>
            setHidden((previous) => ({ ...previous, [key]: value }))
          }
          pinSectionActions={pinSectionActions}
          updatedItems={updatedItems}
          updatedSelectedItemId={selected}
          onSelectUpdatedItem={setSelected}
          onToggleUpdatedItemPinned={state.togglePin}
          onArchiveUpdatedItem={(itemId) =>
            setConversations((previous) => previous.filter((entry) => entry.id !== itemId))
          }
        />
      </div>
      <SessionMentionDropLayer
        enabled
        {...stylex.props(themeStyles.row)}
        onDropSessionId={(sessionId) =>
          setMentioned(conversations.find((entry) => entry.id === sessionId)?.title ?? sessionId)
        }
      >
        <div {...stylex.props(themeStyles.hint)} data-story-mention-target="">
          <p>Drag conversations between rows and onto section headers.</p>
          <p>Hold a dragged conversation near the top or bottom edge to auto-scroll.</p>
          <p>Drag a section header to reorder sections.</p>
          <p>Right-click a pinned conversation for “Move to Section” and “New Section…”.</p>
          <p>Use a named section’s ⋯ menu to hide, rename or delete it.</p>
          <p>A named section’s ⋯ menu also opens a new chat pinned into that section.</p>
          <p>Use Pinned → ⋯ → Visible Sections to show or hide any section.</p>
          <p {...stylex.props(themeStyles.spaced)}>
            Drop a conversation on this pane to mention it, as on a conversation.
          </p>
          <p {...stylex.props(themeStyles.copy)} data-story-mentioned="">
            {mentioned ? `Mentioned: ${mentioned}` : 'Nothing mentioned yet'}
          </p>
          <p {...stylex.props(themeStyles.copy)} data-story-new-chat-section="">
            {newChatSection ? `New chat for section: ${newChatSection}` : 'No new chat started'}
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
    <div {...stylex.props(previewStyles.row)}>
      <div {...stylex.props(themeStyles.glyph)}>
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
      <div {...stylex.props(themeStyles.row2)}>
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

export const HiddenSections: Story = {
  render: () => <PinnedSectionsPlayground initialHidden={{ maintenance: true }} />,
};

export const HiddenByScope: Story = {
  render: () => <HiddenByScopeDemo />,
};

const themeStyles = stylex.create({
  glyph: { height: '100%', width: '280px', flexShrink: 0 },
  row: { flex: '1 1 0%' },
  hint: { padding: 'calc(var(--spacing) * 6)', fontSize: uiText.subheadlineSize, lineHeight: uiText.subheadlineLeading, color: uiColors.secondaryLabel },
  spaced: { marginTop: 'calc(var(--spacing) * 4)' },
  copy: { marginTop: 'calc(var(--spacing) * 2)', color: uiColors.label },
  row2: { flex: '1 1 0%', padding: 'calc(var(--spacing) * 6)', fontSize: uiText.subheadlineSize, lineHeight: uiText.subheadlineLeading, color: uiColors.secondaryLabel },
});

const previewStyles = stylex.create({
  row: { display: 'flex', height: '100vh', backgroundColor: uiColors.secondaryBackground },
});
