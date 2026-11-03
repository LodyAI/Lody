import { memo, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { FolderGit2, Plus, Users } from 'lucide-react';
import { Button, Tabs } from '@lody/ui';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { WorkspaceProject } from '@lody/shared';
import type { SidebarPrimaryView } from '@/atoms/sidebar-state';
import type { SessionListRow } from '@/components/session-list';
import {
  SidebarGroupActivityMark,
  summarizeSidebarGroupActivity,
  SIDEBAR_GROUP_LABEL_CLASS,
} from '@/components/sidebar-row-shared';
import { sidebar } from '../sidebar.tokens.stylex';

const styles = stylex.create({
  switcher: {
    paddingInline: space[1.5],
    paddingTop: space[3],
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    paddingTop: space[1],
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingInline: space[1],
    paddingTop: space[1],
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    width: '100%',
    textAlign: 'start',
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    borderWidth: 0,
    cursor: 'pointer',
    color: sidebar.rowText,
    backgroundColor: { default: 'transparent', ':hover': sidebar.hoverFill },
    outline: { default: 'none', ':focus-visible': `2px solid ${sidebar.selectedFill}` },
  },
  cardSelected: {
    backgroundColor: sidebar.selectedFill,
    color: sidebar.selectedText,
  },
  titleLine: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  title: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 500,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: sidebar.mutedText,
  },
  metaItem: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
  },
  needsYou: { color: 'hsl(var(--primary))' },
  empty: {
    paddingInline: space[2],
    paddingBlock: space[4],
    fontSize: text.footnoteSize,
    color: sidebar.mutedText,
  },
});

/** The 项目 / 对话 capsule under the sidebar's navigation rows. */
export function SidebarPrimaryViewSwitcher({
  value,
  onChange,
}: {
  value: SidebarPrimaryView;
  onChange: (next: SidebarPrimaryView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.switcher)} data-testid="sidebar-primary-view-switcher">
      <Tabs.Root
        value={value}
        onValueChange={(next) => {
          if (next === 'projects' || next === 'chats') onChange(next);
        }}
      >
        <Tabs.List size="small" stretch>
          <Tabs.Tab value="projects">{t('projectHub.tab.projects', 'Projects')}</Tabs.Tab>
          <Tabs.Tab value="chats">{t('projectHub.tab.chats', 'Chats')}</Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
}

const EMPTY_ROWS: SessionListRow[] = [];

const SidebarProjectCard = memo(function SidebarProjectCard({
  project,
  rows = EMPTY_ROWS,
  selected,
  onSelect,
}: {
  project: WorkspaceProject;
  rows?: SessionListRow[];
  selected: boolean;
  onSelect: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const activity = useMemo(() => summarizeSidebarGroupActivity(rows), [rows]);
  const multiMember = project.members.length > 1;
  const needsYou = activity.waiting + activity.failed;
  return (
    <button
      type="button"
      role="listitem"
      data-project-id={project.id}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(project.id)}
      {...stylex.props(styles.card, selected && styles.cardSelected)}
    >
      <span {...stylex.props(styles.titleLine)}>
        <span {...stylex.props(styles.title)}>{project.name}</span>
        <SidebarGroupActivityMark activity={activity} />
      </span>
      <span {...stylex.props(styles.meta)}>
        <span {...stylex.props(styles.metaItem)}>
          {multiMember ? (
            <Users className="h-3 w-3" strokeWidth={1.75} />
          ) : (
            <FolderGit2 className="h-3 w-3" strokeWidth={1.75} />
          )}
          {multiMember
            ? t('projectHub.sidebar.members', '{{count}} repositories', {
                count: project.members.length,
              })
            : t('projectHub.sidebar.single', 'Single repository')}
        </span>
        {/* What needs the user outranks the plain count in this narrow line. */}
        {needsYou > 0 ? (
          <span {...stylex.props(styles.needsYou)}>
            {t('projectHub.sidebar.needsYou', '{{count}} need you', { count: needsYou })}
          </span>
        ) : (
          <span>{t('projectHub.sidebar.conversations', { count: rows.length })}</span>
        )}
      </span>
    </button>
  );
});

export type SidebarProjectListProps = {
  projects: readonly WorkspaceProject[];
  /** Sidebar rows that carry a `projectGroup`; matched by project id. */
  rows: readonly SessionListRow[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
};

export const SidebarProjectList = memo(function SidebarProjectList({
  projects,
  rows,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
}: SidebarProjectListProps) {
  const { t } = useTranslation();
  const rowsByProject = useMemo(() => {
    const map = new Map<string, SessionListRow[]>();
    for (const row of rows) {
      const id = row.projectGroup?.id;
      if (!id) continue;
      const bucket = map.get(id);
      if (bucket) bucket.push(row);
      else map.set(id, [row]);
    }
    return map;
  }, [rows]);

  return (
    <div>
      <div {...stylex.props(styles.header)}>
        <span className={SIDEBAR_GROUP_LABEL_CLASS}>
          {t('projectHub.sidebar.heading', 'Projects')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={t('projectHub.sidebar.create', 'New project')}
          onClick={onCreateProject}
        >
          <Plus className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>
      {projects.length === 0 ? (
        <p {...stylex.props(styles.empty)}>
          {t(
            'projectHub.sidebar.empty',
            'No projects yet. Create one to group repositories and let a coordinator run its conversations.'
          )}
        </p>
      ) : (
        <div {...stylex.props(styles.list)} role="list">
          {projects.map((project) => (
            <SidebarProjectCard
              key={project.id}
              project={project}
              rows={rowsByProject.get(project.id)}
              selected={project.id === selectedProjectId}
              onSelect={onSelectProject}
            />
          ))}
        </div>
      )}
    </div>
  );
});
