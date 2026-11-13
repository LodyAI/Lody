import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@lody/ui/tabs';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Folder, Github } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarProjectView } from '@/atoms/sidebar-state';
import { sidebarSurface } from '@/components/sidebar-surface';
import {
  SIDEBAR_GROUP_LABEL_CLASS,
  SidebarGroupActivityMark,
  type SidebarGroupActivity,
} from '@/components/sidebar-row-shared';

const styles = stylex.create({
  switch: { paddingInline: space[1.5], paddingTop: space[2] },
  list: { display: 'flex', flexDirection: 'column', gap: '1px', paddingTop: space[1] },
  label: { paddingInline: space[2], paddingBottom: space[1] },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    borderWidth: 0,
    textAlign: 'start',
    cursor: 'pointer',
  },
  icon: { flexShrink: 0, width: 14, height: 14 },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 },
  sub: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  empty: { paddingInline: space[2], fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },
});

/** Developer mode: choose whether the sidebar lists projects or conversations. */
export function SidebarProjectViewSwitch({
  value,
  onChange,
}: {
  value: SidebarProjectView;
  onChange: (value: SidebarProjectView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.switch)}>
      <Tabs.Root
        value={value}
        onValueChange={(next) => {
          if (next === 'projects' || next === 'conversations') onChange(next);
        }}
      >
        <Tabs.List size="small" stretch>
          <Tabs.Tab value="projects">{t('projectMode.sidebar.projects', 'Projects')}</Tabs.Tab>
          <Tabs.Tab value="conversations">
            {t('projectMode.sidebar.conversations', 'Conversations')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
}

export type SidebarProjectListItem = {
  /** `coordinatorProjectKeyId` of the project. */
  id: string;
  kind: 'local' | 'github';
  name: string;
  /** Machine name for a local project; empty for a repository. */
  detail: string | null;
  activity: SidebarGroupActivity | null;
};

/** One row per project; opening a row opens that project's coordinator page. */
export function SidebarProjectList({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly SidebarProjectListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.list)} data-testid="sidebar-project-list">
      <div className={SIDEBAR_GROUP_LABEL_CLASS} {...stylex.props(styles.label)}>
        {t('projectMode.sidebar.allProjects', 'All projects')}
      </div>
      {items.length === 0 ? (
        <p {...stylex.props(styles.empty, sidebarSurface.meta)}>
          {t(
            'projectMode.sidebar.noProjects',
            'No projects yet. Add a folder or link a repository.'
          )}
        </p>
      ) : (
        items.map((item) => (
          <SidebarProjectRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

const SidebarProjectRow = memo(function SidebarProjectRow({
  item,
  selected,
  onSelect,
}: {
  item: SidebarProjectListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const Icon = item.kind === 'github' ? Github : Folder;
  return (
    <button
      type="button"
      data-project-id={item.id}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(item.id)}
      {...stylex.props(
        styles.row,
        sidebarSurface.row,
        sidebarSurface.tall,
        sidebarSurface.hover,
        selected && sidebarSurface.selected
      )}
    >
      <Icon aria-hidden="true" strokeWidth={1.5} {...stylex.props(styles.icon)} />
      <span {...stylex.props(styles.text)}>
        <span
          {...stylex.props(
            sidebarSurface.title,
            sidebarSurface.heading,
            selected && sidebarSurface.titleSelected
          )}
        >
          {item.name}
        </span>
        {item.detail ? (
          <span {...stylex.props(styles.sub, sidebarSurface.meta)}>{item.detail}</span>
        ) : null}
      </span>
      <SidebarGroupActivityMark activity={item.activity} />
    </button>
  );
});
