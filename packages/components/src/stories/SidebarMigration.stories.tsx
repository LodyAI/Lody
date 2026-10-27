import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useMemo, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ContextMenu } from '@lody/ui/context-menu';
import { Tooltip } from '@lody/ui/tooltip';
import {
  SessionOpenedByTreeRow,
  SessionRowLeadingSlot,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarSessionTitleText,
  SIDEBAR_ROW_LIST_CLASS,
  SIDEBAR_ROW_TEXT_CLASS,
} from '@/components/sidebar-row-shared';
import { sidebarSurface } from '@/components/sidebar-surface';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';
import { clsx } from 'clsx';

const styles = stylex.create({
  canvas: { minHeight: '100vh', padding: themeSpace[4], backgroundColor: themeColors.background },
  panel: {
    width: 320,
    maxWidth: '100%',
    padding: themeSpace[2],
    backgroundColor: themeColors.sidebar,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    position: 'relative',
  },
  heading: { marginBlock: themeSpace[2], color: themeColors.foreground },
});

const meta = {
  title: 'Components/Sidebar Migration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function RowParts({ largeType = false }: { largeType?: boolean }) {
  const store = useMemo(() => createStore(), []);
  const [expanded, setExpanded] = useState(true);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [archived, setArchived] = useState<string | null>(null);
  const rows = [
    { id: 'opener', title: 'Plan the migration', kind: 'opener' as const },
    ...(expanded
      ? [
          { id: 'child-first', title: 'Check nested row alignment', kind: 'child' as const },
          {
            id: 'child-last',
            title: 'Review a very long session title that should stay clipped',
            kind: 'child' as const,
          },
        ]
      : []),
    { id: 'waiting', title: 'Waiting for permission', kind: 'flat' as const },
    { id: 'unread', title: 'Unread session', kind: 'flat' as const },
    { id: 'plain', title: 'Resting session', kind: 'flat' as const },
  ];
  return (
    <Provider store={store}>
      <Tooltip.Provider>
        <div
          {...stylex.props(styles.canvas)}
          style={largeType ? ({ '--ui-font-size': '18px' } as CSSProperties) : undefined}
        >
          <div {...stylex.props(styles.panel)}>
            <h2 {...stylex.props(styles.heading)}>Production row parts</h2>
            <div className={SIDEBAR_ROW_LIST_CLASS}>
              {rows
                .filter((row) => row.id !== archived)
                .map((row) => (
                  <SessionOpenedByTreeRow key={row.id} depth={row.kind === 'child' ? 1 : 0} gutter>
                    <ContextMenu.Root onOpenChange={(open) => setOpenMenu(open ? row.id : null)}>
                      <ContextMenu.Trigger>
                        <div
                          className={clsx(
                            'group',
                            SIDEBAR_ROW_TEXT_CLASS,
                            stylex.props(
                              styles.row,
                              sidebarSurface.row,
                              sidebarSurface.snug,
                              row.id === 'child-last'
                                ? sidebarSurface.selected
                                : sidebarSurface.hover
                            ).className
                          )}
                          role="button"
                          tabIndex={0}
                          data-fixture-row={row.id}
                          data-menu-open={openMenu === row.id ? '' : undefined}
                          aria-label={row.title}
                        >
                          <SessionRowLeadingSlot
                            showMenuButton
                            menuLabel={`Menu ${row.title}`}
                            openedByTree={
                              row.kind === 'opener'
                                ? {
                                    kind: 'opener',
                                    expanded,
                                    label: expanded
                                      ? 'Collapse fixture children'
                                      : 'Expand fixture children',
                                    onToggle: () => setExpanded((value) => !value),
                                  }
                                : row.kind === 'child'
                                  ? {
                                      kind: 'child',
                                      isFirstChild: row.id === 'child-first',
                                      isLastChild: row.id === 'child-last',
                                    }
                                  : undefined
                            }
                          />
                          <SidebarSessionTitleText
                            sessionId={row.id}
                            selected={row.id === 'child-last'}
                            className={
                              stylex.props(
                                sidebarSurface.title,
                                row.id === 'child-last' && sidebarSurface.titleSelected
                              ).className
                            }
                          >
                            {row.title}
                          </SidebarSessionTitleText>
                          <SidebarRowEndSlot
                            sessionId={row.id}
                            isWaitingPermission={row.id === 'waiting'}
                            hasUnreadMessages={row.id === 'unread'}
                            restIcon={<span>5m</span>}
                            archive={
                              <SidebarRowArchiveButton
                                label={`Archive ${row.title}`}
                                confirmLabel="Confirm archive"
                                onConfirm={() => setArchived(row.id)}
                              />
                            }
                          />
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenu.Content>
                        <ContextMenu.Item onClick={() => {}}>
                          Inspect fixture session
                        </ContextMenu.Item>
                      </ContextMenu.Content>
                    </ContextMenu.Root>
                  </SessionOpenedByTreeRow>
                ))}
            </div>
          </div>
        </div>
      </Tooltip.Provider>
    </Provider>
  );
}

export const RowAnatomy: Story = { render: () => <RowParts /> };
export const LargeInterfaceType: Story = { render: () => <RowParts largeType /> };

const NOW = Date.parse('2026-09-28T12:00:00Z');
const items: SidebarUpdatedItem[] = Array.from({ length: 24 }, (_, index) => ({
  id: `fixture-${index}`,
  kind: index % 2 === 0 ? 'local' : 'chat',
  title: `Migration session ${index + 1}`,
  sectionLabel: 'Local project',
  subtitle: index % 2 === 0 ? 'gentle-garden' : null,
  latestMessageAt: NOW - index * 60000,
  hasUnreadMessages: index === 2,
  isWaitingPermission: index === 3,
  branchName: index === 0 ? 'feature/keep-original-layout' : undefined,
}));

function Updated({ loading = false, empty = false }: { loading?: boolean; empty?: boolean }) {
  const store = useMemo(() => createStore(), []);
  const [full, setFull] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>('fixture-0');
  return (
    <Provider store={store}>
      <Tooltip.Provider>
        <div {...stylex.props(styles.canvas)}>
          <div {...stylex.props(styles.panel)}>
            <SidebarUpdatedSessionList
              items={loading || empty ? [] : items}
              now={new Date(NOW)}
              isLoading={loading}
              selectedItemId={selected}
              onSelectItem={setSelected}
              showProjectContext
              showBranchContext
              collapsedBuckets={{ all: collapsed }}
              onToggleBucket={() => setCollapsed((value) => !value)}
              showFullBuckets={{ all: full }}
              onToggleFullBucket={() => setFull((value) => !value)}
            />
          </div>
        </div>
      </Tooltip.Provider>
    </Provider>
  );
}
export const UpdatedLoading: Story = { render: () => <Updated loading /> };
export const UpdatedEmpty: Story = { render: () => <Updated empty /> };
export const UpdatedOverflow: Story = { render: () => <Updated /> };
