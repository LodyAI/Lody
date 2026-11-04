import { Check, Folder, Monitor } from 'lucide-react';
import { GithubMark } from '../github-mark';
import { WorktreeIcon } from '../landing-replica/icons';
import { ReplicaPrIcon, ReplicaSpinner } from '../landing-replica/sidebar';
import type { ReplicaPrStatus, ReplicaLocale } from '../landing-replica/types';
import { cn } from '../landing-replica/utils';

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
  return (
    <div className="px-2 pb-1 pt-2 text-xs font-semibold text-sidebar-foreground-muted/65">
      {children}
    </div>
  );
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
    <div
      className={cn(
        'flex h-7 min-w-0 items-center gap-1 rounded-md px-2',
        repo
          ? 'text-[0.9em] font-normal text-sidebar-foreground/75'
          : 'text-[0.9em] font-semibold text-sidebar-foreground-muted/65'
      )}
    >
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        {icon === 'github' ? (
          <GithubMark className="h-3.5 w-3.5 opacity-80" />
        ) : (
          <Folder className="h-3.5 w-3.5 opacity-80" />
        )}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

function RowEnd({ row }: { row: DocsSessionRow }) {
  if (row.working) {
    return <ReplicaSpinner className="h-3 w-3 text-primary" />;
  }
  if (row.unread) {
    return <span className="h-2 w-2 rounded-full bg-primary" />;
  }
  if (row.prNumber && row.prStatus) {
    return <ReplicaPrIcon status={row.prStatus} ciState={row.ciState} />;
  }
  return <span className="text-[11px] tabular-nums text-muted-foreground">{row.ageLabel}</span>;
}

function SessionRow({ row }: { row: DocsSessionRow }) {
  return (
    <div
      aria-current={row.selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left',
        row.selected
          ? 'bg-sidebar-selection text-sidebar-selection-foreground'
          : 'text-sidebar-foreground'
      )}
    >
      <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-normal">{row.title}</span>
      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center">
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
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span
        role="img"
        aria-label={label}
        title={label}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-sidebar-foreground-muted"
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 truncate text-sidebar-foreground">{value}</span>
    </div>
  );
}

function SessionInfoCard({ row, copy }: { row: DocsSessionRow; copy: DocsPreviewCopy }) {
  const hasChanges = Boolean(row.addedLines || row.deletedLines);
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-card-foreground">
          {row.title}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {row.ageLabel}
        </span>
      </div>
      <div className="mt-3 space-y-2">
        <Fact icon="repository" label={copy.repositoryFact} value={copy.repo} />
        {row.branch ? <Fact icon="worktree" label={copy.worktreeFact} value={row.branch} /> : null}
        <Fact icon="machine" label={copy.machineFact} value={copy.machine} />
      </div>
      <div className="my-3 h-px bg-border" />
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {row.prNumber && row.prStatus ? (
          <>
            <ReplicaPrIcon status={row.prStatus} ciState={row.ciState} />
            <span className="shrink-0 font-medium text-sidebar-foreground">#{row.prNumber}</span>
            <span className="shrink-0 text-muted-foreground">{copy.prOpen}</span>
          </>
        ) : null}
        {row.ciState === 'success' ? (
          <>
            <span className="text-muted-foreground/60" aria-hidden="true">
              ·
            </span>
            <span className="flex min-w-0 items-center gap-1 text-status-success">
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{copy.checksPassed}</span>
            </span>
          </>
        ) : null}
        {hasChanges ? (
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5 font-medium tabular-nums"
            title={copy.changes}
          >
            <span className="text-github-addition">+{row.addedLines}</span>
            <span className="text-github-deletion">−{row.deletedLines}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SessionGroup({ rows, selectedId }: { rows: DocsSessionRow[]; selectedId?: string }) {
  return (
    <div className="flex flex-col gap-px">
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
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm"
      >
        <div className="flex flex-col lg:flex-row">
          <div className="w-full shrink-0 border-b border-border bg-sidebar-background p-2 lg:w-[272px] lg:border-b-0 lg:border-r">
            <SectionLabel>{copy.localProjects}</SectionLabel>
            <GroupHeader icon="folder" label={copy.folder} />
            <SessionGroup rows={local} />
            <SectionLabel>{copy.chats}</SectionLabel>
            <SessionGroup rows={chats} />
            <SectionLabel>{copy.githubWorktrees}</SectionLabel>
            <GroupHeader icon="github" label={copy.repo} repo />
            <SessionGroup rows={github} selectedId={selected?.id} />
          </div>
          <div className="min-w-0 flex-1 bg-background p-3 sm:p-4">
            <div className="mx-auto w-full max-w-sm">
              <SessionInfoCard row={selected} copy={copy} />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 text-center text-xs text-muted-foreground">{copy.caption}</div>
    </div>
  );
}
