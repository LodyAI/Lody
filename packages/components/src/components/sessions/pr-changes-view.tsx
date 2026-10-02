'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { AlertCircle, ArrowRight, ChevronDown, FileDiff, ExternalLink, Search } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { GitHubPullRequestCommit, GitHubPullRequestFile } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Select } from '@lody/ui/select';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import type { GitHubPrDiffState, GitHubPrFileContent } from '@/hooks/use-github-pr-diff';
import { sumPrFileStats, type PrCommitSelection } from '@/lib/github-pr-diff';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[2],
  },
  select: { minWidth: '12rem', maxWidth: '100%' },
  commitSelect: { flex: '1 1 100%', minWidth: 0 },
  rangeGroup: {
    display: 'flex',
    flex: '1 1 100%',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[2],
    paddingBlock: space[1],
    borderRadius: radius.mini,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 4%)`,
  },
  rangeFields: {
    display: 'flex',
    flex: '1 1 24rem',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  rangeField: {
    display: 'flex',
    flex: '1 1 0',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
  },
  rangeFieldLabel: {
    flexShrink: 0,
    color: colors.secondaryLabel,
    fontSize: '0.8em',
    fontWeight: 500,
  },
  rangeSelect: { flex: '1 1 0', minWidth: 0, maxWidth: '100%' },
  rangeArrow: { flexShrink: 0, color: colors.tertiaryLabel },
  filter: { flex: '1 1 12rem', minWidth: '10rem' },
  stats: { display: 'inline-flex', alignItems: 'center', gap: space[1.5], fontSize: '0.85em' },
  additions: { color: 'hsl(var(--github-open))', fontVariantNumeric: 'tabular-nums' },
  deletions: { color: 'hsl(var(--github-closed))', fontVariantNumeric: 'tabular-nums' },
  muted: { color: colors.secondaryLabel },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.mini,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 6%)`,
    color: colors.secondaryLabel,
    fontSize: '0.9em',
  },
  files: { display: 'flex', flexDirection: 'column', gap: space[2] },
  file: {
    overflow: 'hidden',
    borderRadius: radius.mini,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: `color-mix(in oklab, transparent, ${colors.label} 12%)`,
    backgroundColor: colors.background,
  },
  fileHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
  },
  fileToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    flex: 1,
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
  },
  chevron: {
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: '150ms',
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  fileName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  status: { flexShrink: 0, color: colors.tertiaryLabel, fontSize: '0.8em' },
  diff: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: `color-mix(in oklab, transparent, ${colors.label} 10%)`,
  },
  unavailable: { padding: space[3], color: colors.secondaryLabel, fontSize: '0.85em' },
  external: { marginInlineStart: 'auto' },
});

function commitLabel(commit: GitHubPullRequestCommit): string {
  return `${commit.message} (${commit.sha.slice(0, 7)})`;
}

function fileStatusLabel(
  file: GitHubPullRequestFile,
  t: (key: string, fallback: string) => string
): string {
  if (file.status === 'renamed' && file.previousPath) {
    return t('sessions.prTab.fileRenamed', 'renamed from {{path}}').replace(
      '{{path}}',
      file.previousPath
    );
  }
  return t(`sessions.prTab.fileStatus.${file.status}`, file.status);
}

function unavailableLabel(
  content: Extract<GitHubPrFileContent, { status: 'unavailable' }>,
  t: (key: string, fallback: string) => string
) {
  switch (content.reason) {
    case 'large':
      return t('sessions.prTab.diffLargeFile', 'This file is too large to render here.');
    case 'missing':
      return t(
        'sessions.prTab.diffMissingFile',
        'The file is unavailable at one side of this selection.'
      );
    case 'binary':
      return t('sessions.prTab.diffBinaryFile', 'Binary files cannot be rendered as text.');
    default:
      return t('sessions.prTab.diffUnavailable', 'Diff content is unavailable.');
  }
}

export interface PrChangesViewProps {
  state: GitHubPrDiffState;
  commits: GitHubPullRequestCommit[];
  files: GitHubPullRequestFile[];
  selection: PrCommitSelection;
  onSelectionChange: (selection: PrCommitSelection) => void;
  contentByPath: ReadonlyMap<string, GitHubPrFileContent>;
  onLoadFile: (file: GitHubPullRequestFile) => Promise<void>;
  onRefresh: () => void;
  error: Error | null;
  historical: boolean;
}

export function PrChangesView({
  state,
  commits,
  files,
  selection,
  onSelectionChange,
  contentByPath,
  onLoadFile,
  onRefresh,
  error,
  historical,
}: PrChangesViewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [startSha, setStartSha] = useState(commits[0]?.sha ?? '');
  const [endSha, setEndSha] = useState(commits.at(-1)?.sha ?? '');
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (commits.length === 0) return;
    const firstSha = commits[0]!.sha;
    const lastSha = commits.at(-1)!.sha;
    setStartSha((current) =>
      commits.some((commit) => commit.sha === current) ? current : firstSha
    );
    setEndSha((current) => (commits.some((commit) => commit.sha === current) ? current : lastSha));
  }, [commits]);
  useEffect(() => {
    setOpenPaths(new Set());
  }, [selection]);
  const stats = useMemo(() => sumPrFileStats(files), [files]);
  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? files.filter(
          (file) =>
            file.path.toLowerCase().includes(query) ||
            file.previousPath?.toLowerCase().includes(query)
        )
      : files;
  }, [files, filter]);
  const selectedValue =
    selection.type === 'all' ? 'all' : selection.type === 'commit' ? selection.sha : 'range';
  const toggleFile = (file: GitHubPullRequestFile) => {
    const wasOpen = openPaths.has(file.path);
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
    if (!wasOpen && !contentByPath.has(file.path)) void onLoadFile(file);
  };

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.toolbar)}>
        <Select.Root
          value={selectedValue}
          onValueChange={(value: string | null) => {
            if (!value || value === 'all') onSelectionChange({ type: 'all' });
            else if (value === 'range')
              onSelectionChange({
                type: 'range',
                startSha: startSha || commits[0]?.sha || '',
                endSha: endSha || commits.at(-1)?.sha || '',
              });
            else onSelectionChange({ type: 'commit', sha: value });
          }}
        >
          <Select.Trigger
            size="small"
            aria-label={t('sessions.prTab.commitSelection', 'Select commits')}
            {...stylex.props(styles.select, styles.commitSelect)}
          >
            <Select.Value>
              {(value: string | null) => {
                if (!value || value === 'all') {
                  return t('sessions.prTab.allCommits', 'All commits');
                }
                if (value === 'range') {
                  return t('sessions.prTab.commitRangeValue', 'Commit range');
                }
                const commit = commits.find((item) => item.sha === value);
                return commit ? commitLabel(commit) : value;
              }}
            </Select.Value>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all">{t('sessions.prTab.allCommits', 'All commits')}</Select.Item>
            {commits.map((commit) => (
              <Select.Item key={commit.sha} value={commit.sha}>
                {commitLabel(commit)}
              </Select.Item>
            ))}
            <Select.Item value="range">
              {t('sessions.prTab.commitRange', 'Select a range')}
            </Select.Item>
          </Select.Content>
        </Select.Root>
        {selection.type === 'range' && (
          <div {...stylex.props(styles.rangeGroup)}>
            <div {...stylex.props(styles.rangeFields)}>
              <div {...stylex.props(styles.rangeField)}>
                <span {...stylex.props(styles.rangeFieldLabel)}>
                  {t('sessions.prTab.rangeFrom', 'From')}
                </span>
                <Select.Root
                  value={startSha}
                  onValueChange={(value: string | null) => {
                    if (value) {
                      setStartSha(value);
                      onSelectionChange({ type: 'range', startSha: value, endSha });
                    }
                  }}
                >
                  <Select.Trigger
                    size="small"
                    aria-label={t('sessions.prTab.rangeStart', 'Range start')}
                    {...stylex.props(styles.rangeSelect)}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {commits
                      .filter(
                        (commit) =>
                          commits.indexOf(commit) <=
                          commits.findIndex((item) => item.sha === endSha)
                      )
                      .map((commit) => (
                        <Select.Item key={commit.sha} value={commit.sha}>
                          {commitLabel(commit)}
                        </Select.Item>
                      ))}
                  </Select.Content>
                </Select.Root>
              </div>
              <ArrowRight size={16} aria-hidden {...stylex.props(styles.rangeArrow)} />
              <div {...stylex.props(styles.rangeField)}>
                <span {...stylex.props(styles.rangeFieldLabel)}>
                  {t('sessions.prTab.rangeTo', 'To')}
                </span>
                <Select.Root
                  value={endSha}
                  onValueChange={(value: string | null) => {
                    if (value) {
                      setEndSha(value);
                      onSelectionChange({ type: 'range', startSha, endSha: value });
                    }
                  }}
                >
                  <Select.Trigger
                    size="small"
                    aria-label={t('sessions.prTab.rangeEnd', 'Range end')}
                    {...stylex.props(styles.rangeSelect)}
                  >
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {commits
                      .filter(
                        (commit) =>
                          commits.indexOf(commit) >=
                          commits.findIndex((item) => item.sha === startSha)
                      )
                      .map((commit) => (
                        <Select.Item key={commit.sha} value={commit.sha}>
                          {commitLabel(commit)}
                        </Select.Item>
                      ))}
                  </Select.Content>
                </Select.Root>
              </div>
            </div>
          </div>
        )}
        <div {...stylex.props(styles.filter)}>
          <Input
            size="small"
            value={filter}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
            placeholder={t('sessions.prTab.filterFiles', 'Filter files…')}
            leading={<Search size={14} aria-hidden />}
            aria-label={t('sessions.prTab.filterFiles', 'Filter files')}
          />
        </div>
        <span {...stylex.props(styles.stats)}>
          <span {...stylex.props(styles.additions)}>+{stats.additions}</span>
          <span {...stylex.props(styles.deletions)}>−{stats.deletions}</span>
          <span {...stylex.props(styles.muted)}>
            {files.length} {t('sessions.prTab.files', 'files')}
          </span>
        </span>
      </div>

      {historical && (
        <div {...stylex.props(styles.notice)}>
          <FileDiff size={16} aria-hidden />
          <span>
            {t(
              'sessions.prTab.historicalReadOnly',
              'Viewing a historical commit selection. Historical selections are read-only.'
            )}
          </span>
        </div>
      )}
      {state === 'loading' && (
        <div {...stylex.props(styles.notice)}>
          {t('sessions.prTab.loadingChanges', 'Loading changed files…')}
        </div>
      )}
      {state === 'error' && (
        <div {...stylex.props(styles.notice)}>
          <AlertCircle size={16} aria-hidden />
          <span>
            {error?.message ?? t('sessions.prTab.changesError', 'Failed to load changes.')}
          </span>
          <Button type="button" size="mini" variant="secondary" onClick={onRefresh}>
            {t('sessions.prTab.retry', 'Retry')}
          </Button>
        </div>
      )}
      {state === 'ready' && visibleFiles.length === 0 && (
        <div {...stylex.props(styles.notice)}>
          {t('sessions.prTab.noMatchingFiles', 'No matching files.')}
        </div>
      )}
      <div {...stylex.props(styles.files)}>
        {visibleFiles.map((file) => {
          const open = openPaths.has(file.path);
          const content = contentByPath.get(file.path);
          return (
            <section key={`${file.path}:${file.sha ?? ''}`} {...stylex.props(styles.file)}>
              <div {...stylex.props(styles.fileHeader)}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleFile(file)}
                  {...stylex.props(styles.fileToggle)}
                >
                  <ChevronDown
                    size={16}
                    aria-hidden
                    {...stylex.props(styles.chevron, open && styles.chevronOpen)}
                  />
                  <span {...stylex.props(styles.fileName)} title={file.path}>
                    {file.path}
                  </span>
                  <span {...stylex.props(styles.status)}>{fileStatusLabel(file, t)}</span>
                  <span {...stylex.props(styles.additions)}>+{file.additions}</span>
                  <span {...stylex.props(styles.deletions)}>−{file.deletions}</span>
                </button>
                {file.blobUrl && (
                  <a
                    href={file.blobUrl}
                    target="_blank"
                    rel="noreferrer"
                    {...stylex.props(styles.external)}
                    aria-label={t('sessions.prTab.openFileOnGitHub', 'Open file on GitHub')}
                    title={t('sessions.prTab.openFileOnGitHub', 'Open file on GitHub')}
                  >
                    <ExternalLink size={14} aria-hidden />
                  </a>
                )}
              </div>
              {open && (
                <div {...stylex.props(styles.diff)}>
                  {!content || content.status === 'loading' ? (
                    <div {...stylex.props(styles.unavailable)}>
                      {t('sessions.prTab.loadingFile', 'Loading file…')}
                    </div>
                  ) : content.status === 'unavailable' ? (
                    <div {...stylex.props(styles.unavailable)}>{unavailableLabel(content, t)}</div>
                  ) : (
                    <DiffViewer
                      path={file.path}
                      oldText={content.oldText}
                      newText={content.newText}
                      showHeader={false}
                      diffStyle="unified"
                      cachePrerenderedHtml={false}
                    />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
