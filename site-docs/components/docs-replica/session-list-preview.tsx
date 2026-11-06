import * as stylex from '@stylexjs/stylex';
import { Check, Folder, Monitor } from 'lucide-react';
import { GithubMark } from '../github-mark';
import { WorktreeIcon } from '../landing-replica/icons';
import { ReplicaPrIcon, ReplicaSpinner } from '../landing-replica/sidebar';
import type { ReplicaPrStatus, ReplicaLocale } from '../landing-replica/types';
const previewStyles = stylex.create({
  text: {
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-top': 'calc(var(--spacing) * 2)',
    'padding-bottom': 'var(--spacing)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 65%, transparent)',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
  },
  text2: {
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-normal)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground)) 75%, transparent)',
  },
  text3: {
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted)) 65%, transparent)',
  },
  row2: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  frame: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    opacity: '80%',
  },
  section: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  text4: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--primary))',
  },
  frame2: {
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary))',
  },
  text5: {
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
    'font-variant-numeric': 'tabular-nums',
  },
  row3: {
    display: 'flex',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'text-align': 'left',
  },
  text6: {
    'background-color': 'hsl(var(--sidebar-selection))',
    color: 'hsl(var(--sidebar-selection-foreground))',
  },
  text7: {
    color: 'hsl(var(--sidebar-foreground))',
  },
  frame3: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
  },
  text8: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-normal)',
  },
  row4: {
    display: 'flex',
    height: 'calc(var(--spacing) * 5)',
    'min-width': 'calc(var(--spacing) * 5)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
  },
  row5: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  row6: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    color: 'hsl(var(--sidebar-foreground-muted))',
  },
  frame4: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  text9: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    color: 'hsl(var(--sidebar-foreground))',
  },
  section2: {
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    padding: 'calc(var(--spacing) * 3)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  row7: {
    display: 'flex',
    'align-items': 'baseline',
    gap: 'calc(var(--spacing) * 3)',
  },
  text10: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'hsl(var(--card-foreground))',
  },
  text11: {
    'flex-shrink': '0',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
    'font-variant-numeric': 'tabular-nums',
  },
  section3: {
    'margin-top': 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 'calc(calc(var(--spacing) * 2) * 0)',
      'margin-block-end': 'calc(calc(var(--spacing) * 2) * calc(1 - 0))',
    },
  },
  frame5: {
    'margin-block': 'calc(var(--spacing) * 3)',
    height: '1px',
    'background-color': 'hsl(var(--border))',
  },
  text12: {
    'flex-shrink': '0',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--sidebar-foreground))',
  },
  text13: {
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  text14: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
  },
  row8: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    color: 'hsl(var(--status-success))',
  },
  frame6: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
  },
  section4: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row9: {
    'margin-left': 'auto',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-weight': 'var(--font-weight-medium)',
    'font-variant-numeric': 'tabular-nums',
  },
  text15: {
    color: 'hsl(var(--github-addition))',
  },
  text16: {
    color: 'hsl(var(--github-deletion))',
  },
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: '1px',
  },
  section5: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  text17: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    '@media (width >= 64rem)': {
      'flex-direction': 'row',
    },
  },
  frame7: {
    width: '100%',
    'flex-shrink': '0',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--sidebar-background))',
    padding: 'calc(var(--spacing) * 2)',
    '@media (width >= 64rem)': {
      width: '272px',
      'border-right-style': 'solid',
      'border-right-width': '1px',
      'border-bottom-style': 'solid',
      'border-bottom-width': '0px',
    },
  },
  section6: {
    'min-width': '0px',
    flex: '1',
    'background-color': 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 3)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 4)',
    },
  },
  frame8: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': 'var(--container-sm)',
  },
  text18: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'text-align': 'center',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
});

/* Display-only docs preview of the sidebar session list. It copies the current
   app's `session-list.tsx` row/group markup with synthetic data and never imports
   the app (see `scripts/app-boundary.mjs`). The info-card panel stands in for the
   hover card the desktop app opens beside a row; the page shows it in place so
   the branch, PR state, and line change stay visible without interaction. */

type DocsSessionRow = {
  id: string;
  title: string;
  kind: 'local' | 'chat' | 'github';
  branch?: string;
  prNumber?: number;
  prStatus?: ReplicaPrStatus;
  ciState?: 'success' | 'failure' | 'pending';
  addedLines?: number;
  deletedLines?: number;
  ageLabel: string;
  unread?: boolean;
  working?: boolean;
  selected?: boolean;
};

type DocsPreviewCopy = {
  localProjects: string;
  chats: string;
  githubWorktrees: string;
  repo: string;
  folder: string;
  repositoryFact: string;
  worktreeFact: string;
  machineFact: string;
  machine: string;
  prOpen: string;
  checksPassed: string;
  changes: string;
  caption: string;
  rows: {
    local: string;
    chat: string;
    firstGithub: string;
    secondGithub: string;
  };
};

const REPO = 'loro-dev/lody';
const MACHINE = 'Mac Studio';

const COPY: Record<ReplicaLocale, DocsPreviewCopy> = {
  en: {
    localProjects: 'Local Projects',
    chats: 'Chats',
    githubWorktrees: 'GitHub Worktrees',
    repo: REPO,
    folder: 'notes-app',
    repositoryFact: 'Repository',
    worktreeFact: 'Worktree',
    machineFact: 'Machine',
    machine: MACHINE,
    prOpen: 'Open',
    checksPassed: 'CI passed',
    changes: 'Changes',
    caption:
      'Mock data illustration. The panel on the right mirrors the session info card the desktop app shows when you hover a session.',
    rows: {
      local: 'Fix roadmap issue timestamps',
      chat: 'Explain the auth token flow',
      firstGithub: 'Add health endpoint and version test',
      secondGithub: 'Plan keyboard shortcuts settings',
    },
  },
  zh: {
    localProjects: '本地项目',
    chats: '对话',
    githubWorktrees: 'GitHub Worktrees',
    repo: REPO,
    folder: 'notes-app',
    repositoryFact: '仓库',
    worktreeFact: '工作树',
    machineFact: '机器',
    machine: MACHINE,
    prOpen: '已开启',
    checksPassed: 'CI 已通过',
    changes: '变更',
    caption: '模拟数据示意。右侧面板对应桌面客户端中悬停会话时显示的会话详情卡。',
    rows: {
      local: '修复路线图时间戳问题',
      chat: '解释登录令牌流程',
      firstGithub: '新增健康检查接口与版本测试',
      secondGithub: '规划键盘快捷键设置',
    },
  },
};

function buildRows(locale: ReplicaLocale): DocsSessionRow[] {
  const { rows } = COPY[locale];
  return [
    {
      id: 'docs-local-1',
      title: rows.local,
      kind: 'local',
      branch: 'codex/fix-roadmap-updated-at',
      ageLabel: '1h',
    },
    {
      id: 'docs-chat-1',
      title: rows.chat,
      kind: 'chat',
      ageLabel: '3h',
      unread: true,
    },
    {
      id: 'docs-github-1',
      title: rows.firstGithub,
      kind: 'github',
      branch: 'feat/health-endpoint',
      prNumber: 2564,
      prStatus: 'open',
      ciState: 'success',
      addedLines: 18,
      deletedLines: 3,
      ageLabel: '2h',
      selected: true,
    },
    {
      id: 'docs-github-2',
      title: rows.secondGithub,
      kind: 'github',
      branch: 'plan/keyboard-shortcuts',
      ageLabel: '1d',
      working: true,
    },
  ];
}

function SectionLabel({ children }: { children: string }) {
  return <div {...stylex.props(previewStyles.text)}>{children}</div>;
}

function GroupHeader({
  icon,
  label,
  repo,
}: {
  icon: 'folder' | 'github';
  label: string;
  repo?: boolean;
}) {
  return (
    <div {...stylex.props(previewStyles.row, repo ? previewStyles.text2 : previewStyles.text3)}>
      <span {...stylex.props(previewStyles.row2)}>
        {icon === 'github' ? (
          <GithubMark {...stylex.props(previewStyles.frame)} />
        ) : (
          <Folder {...stylex.props(previewStyles.frame)} />
        )}
      </span>
      <span {...stylex.props(previewStyles.section)}>{label}</span>
    </div>
  );
}

function RowEnd({ row }: { row: DocsSessionRow }) {
  if (row.working) {
    return <ReplicaSpinner xstyle={previewStyles.text4} />;
  }
  if (row.unread) {
    return <span {...stylex.props(previewStyles.frame2)} />;
  }
  if (row.prNumber && row.prStatus) {
    return <ReplicaPrIcon status={row.prStatus} ciState={row.ciState} />;
  }
  return <span {...stylex.props(previewStyles.text5)}>{row.ageLabel}</span>;
}

function SessionRow({ row }: { row: DocsSessionRow }) {
  return (
    <div
      aria-current={row.selected ? 'true' : undefined}
      {...stylex.props(
        previewStyles.row3,
        row.selected ? previewStyles.text6 : previewStyles.text7
      )}
    >
      <span {...stylex.props(previewStyles.frame3)} aria-hidden="true" />
      <span {...stylex.props(previewStyles.text8)}>{row.title}</span>
      <span {...stylex.props(previewStyles.row4)}>
        <RowEnd row={row} />
      </span>
    </div>
  );
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: 'repository' | 'worktree' | 'machine';
  label: string;
  value: string;
}) {
  const Icon = icon === 'repository' ? GithubMark : icon === 'worktree' ? WorktreeIcon : Monitor;
  return (
    <div {...stylex.props(previewStyles.row5)}>
      <span role="img" aria-label={label} title={label} {...stylex.props(previewStyles.row6)}>
        <Icon {...stylex.props(previewStyles.frame4)} />
      </span>
      <span {...stylex.props(previewStyles.text9)}>{value}</span>
    </div>
  );
}

function SessionInfoCard({ row, copy }: { row: DocsSessionRow; copy: DocsPreviewCopy }) {
  const hasChanges = Boolean(row.addedLines || row.deletedLines);
  return (
    <div {...stylex.props(previewStyles.section2)}>
      <div {...stylex.props(previewStyles.row7)}>
        <span {...stylex.props(previewStyles.text10)}>{row.title}</span>
        <span {...stylex.props(previewStyles.text11)}>{row.ageLabel}</span>
      </div>
      <div {...stylex.props(previewStyles.section3)}>
        <Fact icon="repository" label={copy.repositoryFact} value={copy.repo} />
        {row.branch ? <Fact icon="worktree" label={copy.worktreeFact} value={row.branch} /> : null}
        <Fact icon="machine" label={copy.machineFact} value={copy.machine} />
      </div>
      <div {...stylex.props(previewStyles.frame5)} />
      <div {...stylex.props(previewStyles.row5)}>
        {row.prNumber && row.prStatus ? (
          <>
            <ReplicaPrIcon status={row.prStatus} ciState={row.ciState} />
            <span {...stylex.props(previewStyles.text12)}>#{row.prNumber}</span>
            <span {...stylex.props(previewStyles.text13)}>{copy.prOpen}</span>
          </>
        ) : null}
        {row.ciState === 'success' ? (
          <>
            <span {...stylex.props(previewStyles.text14)} aria-hidden="true">
              ·
            </span>
            <span {...stylex.props(previewStyles.row8)}>
              <Check {...stylex.props(previewStyles.frame6)} aria-hidden="true" />
              <span {...stylex.props(previewStyles.section4)}>{copy.checksPassed}</span>
            </span>
          </>
        ) : null}
        {hasChanges ? (
          <span {...stylex.props(previewStyles.row9)} title={copy.changes}>
            <span {...stylex.props(previewStyles.text15)}>+{row.addedLines}</span>
            <span {...stylex.props(previewStyles.text16)}>−{row.deletedLines}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SessionGroup({ rows, selectedId }: { rows: DocsSessionRow[]; selectedId?: string }) {
  return (
    <div {...stylex.props(previewStyles.stack)}>
      {rows.map((row) => (
        <SessionRow key={row.id} row={{ ...row, selected: row.id === selectedId }} />
      ))}
    </div>
  );
}

/**
 * A docs-owned, display-only replica of the current sidebar session list. It
 * takes only a locale and renders synthetic data, so the page never ships a
 * stale screenshot or real user content.
 */
export function SessionListPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = COPY[locale];
  const rows = buildRows(locale);
  const local = rows.filter((row) => row.kind === 'local');
  const chats = rows.filter((row) => row.kind === 'chat');
  const github = rows.filter((row) => row.kind === 'github');
  const selected = github.find((row) => row.selected) ?? github[0];

  return (
    <div {...stylex.props(previewStyles.section5)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text17).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.stack2)}>
          <div {...stylex.props(previewStyles.frame7)}>
            <SectionLabel>{copy.localProjects}</SectionLabel>
            <GroupHeader icon="folder" label={copy.folder} />
            <SessionGroup rows={local} />
            <SectionLabel>{copy.chats}</SectionLabel>
            <SessionGroup rows={chats} />
            <SectionLabel>{copy.githubWorktrees}</SectionLabel>
            <GroupHeader icon="github" label={copy.repo} repo />
            <SessionGroup rows={github} selectedId={selected?.id} />
          </div>
          <div {...stylex.props(previewStyles.section6)}>
            <div {...stylex.props(previewStyles.frame8)}>
              <SessionInfoCard row={selected} copy={copy} />
            </div>
          </div>
        </div>
      </div>
      <div {...stylex.props(previewStyles.text18)}>{copy.caption}</div>
    </div>
  );
}
