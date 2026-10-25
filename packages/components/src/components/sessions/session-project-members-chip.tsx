import * as stylex from '@stylexjs/stylex';
import { Folders, Folder, GitBranch, Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectMemberId, SessionPullRequestCiState } from '@lody/shared';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionProjectMemberRow } from '@/lib/session-project-members';
import { cn } from '@/lib/utils';
import { PopoverActionChip } from './info-chip';
import { PR_STATUS_META } from './pull-request-badge';

const styles = stylex.create({
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    padding: space[2],
    borderBottom: `1px solid ${colors.separator}`,
  },
  title: { fontSize: text.footnoteSize, color: colors.label, fontWeight: 500 },
  subtitle: { fontSize: text.footnoteSize, color: colors.secondaryLabel },
  list: { maxHeight: 360, overflowY: 'auto', padding: space[1], minWidth: 340 },
  // Two lines per repository: its GitHub identity (or local directory) and,
  // underneath, where it sits plus its branch. Submodules are indented by their
  // placement depth, so the panel shows the same forest the conversation has.
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '40px',
    paddingBlock: space[1],
    paddingInlineEnd: space[1.5],
    borderRadius: '6px',
    backgroundColor: 'transparent',
    fontSize: text.footnoteSize,
    ':hover': { backgroundColor: colors.hoverFill },
  },
  rowSelected: { backgroundColor: colors.selectedFill },
  glyph: { width: '14px', height: '14px', flexShrink: 0, color: colors.tertiaryLabel },
  select: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '1px',
    flex: 1,
    minWidth: 0,
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  selectStatic: { cursor: 'default' },
  identity: {
    color: colors.label,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  identitySelected: { fontWeight: 500 },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  metaPath: {
    minWidth: 0,
    maxWidth: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  metaDot: { flexShrink: 0, color: colors.tertiaryLabel },
  branch: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: {
    width: '8px',
    height: '8px',
    flexShrink: 0,
    borderRadius: '50%',
    backgroundColor: colors.warning,
  },
  prSlot: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: '64px',
    flexShrink: 0,
  },
  pr: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '3px',
    minWidth: 0,
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    ':hover': { textDecoration: 'underline' },
  },
  prIcon: { width: '12px', height: '12px', flexShrink: 0 },
  noPr: { color: colors.tertiaryLabel },
  ci: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  ciSuccess: { backgroundColor: colors.success },
  ciFailure: { backgroundColor: colors.destructive },
  ciPending: { backgroundColor: colors.tertiaryLabel },
  hint: {
    padding: `${space[1.5]} ${space[2]}`,
    borderTop: `1px solid ${colors.separator}`,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
});

const CI_STYLE: Partial<Record<SessionPullRequestCiState, keyof typeof styles>> = {
  s: 'ciSuccess',
  f: 'ciFailure',
  e: 'ciFailure',
  p: 'ciPending',
};

/**
 * The repositories of a multi-repository conversation, one click away.
 *
 * A plain cluster action like Related sessions: it never takes the stage.
 * Each row says where the repository sits, its branch, whether it holds work
 * that is not on the remote yet, and its current PR. Rows are indented by
 * placement depth; selecting one makes the context stage describe that
 * repository (its branch, path, diff and PR) instead of the first Member.
 */
export function SessionProjectMembersChip({
  groupName,
  rows,
  selectedMemberId,
  onSelectMember,
  onOpenPullRequest,
  defaultOpen,
}: {
  groupName: string;
  rows: readonly SessionProjectMemberRow[];
  /** The repository the context stage is describing. */
  selectedMemberId?: ProjectMemberId | null;
  /** Select a repository and close the panel; omitted means read-only. */
  onSelectMember?: (memberId: ProjectMemberId) => void;
  onOpenPullRequest: (url: string) => void;
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const prCount = rows.filter((row) => row.pr).length;
  const label = t('sessions.projectMembers.label', 'Repositories');
  return (
    <PopoverActionChip
      icon={Folders}
      label={label}
      value={String(rows.length)}
      defaultOpen={defaultOpen}
      content={(close) => (
        <div>
          <div {...stylex.props(styles.header)}>
            <span {...stylex.props(styles.title)}>{groupName}</span>
            <span {...stylex.props(styles.subtitle)}>
              {t('sessions.projectMembers.summary', '{{repos}} repositories · {{prs}} PRs', {
                repos: rows.length,
                prs: prCount,
              })}
            </span>
          </div>
          <div {...stylex.props(styles.list)} role="list">
            {rows.map((row) => (
              <MemberRow
                key={row.id}
                row={row}
                selected={row.id === selectedMemberId}
                onSelect={
                  onSelectMember
                    ? () => {
                        onSelectMember(row.id);
                        close();
                      }
                    : undefined
                }
                onOpenPullRequest={onOpenPullRequest}
              />
            ))}
          </div>
          {onSelectMember ? (
            <div {...stylex.props(styles.hint)}>
              {t(
                'sessions.projectMembers.selectHint',
                'Select a repository to show its branch and pull request below.'
              )}
            </div>
          ) : null}
        </div>
      )}
    />
  );
}

function MemberRow({
  row,
  selected,
  onSelect,
  onOpenPullRequest,
}: {
  row: SessionProjectMemberRow;
  selected: boolean;
  onSelect?: () => void;
  onOpenPullRequest: (url: string) => void;
}) {
  const { t } = useTranslation();
  const Glyph = row.isSubmodule ? GitBranch : row.kind === 'github' ? Github : Folder;
  const inPlace = row.access === 'additional' || row.access === 'link';
  const pending = row.dirty
    ? t('sessions.projectMembers.dirty', 'Uncommitted changes')
    : row.unpushed
      ? t('sessions.projectMembers.unpushed', 'Commits not pushed yet')
      : null;
  const statusMeta = row.pr ? PR_STATUS_META[row.pr.status] : null;
  const ciStyle = row.pr?.ciState ? CI_STYLE[row.pr.ciState] : undefined;
  const identity = row.repoFullName ?? row.path;
  const location = inPlace
    ? t('sessions.projectMembers.inPlace', 'Original directory · not isolated')
    : (row.branch ?? '');
  const showPath = Boolean(row.repoFullName && row.repoFullName !== row.path);
  const label = [identity, row.path, location, pending].filter(Boolean).join(' · ');
  const content = (
    <>
      <span {...stylex.props(styles.identity, selected && styles.identitySelected)}>
        {identity}
      </span>
      <span {...stylex.props(styles.meta)}>
        {showPath ? (
          <>
            <span {...stylex.props(styles.metaPath)} title={row.path}>
              {row.path}
            </span>
            {location ? (
              <span aria-hidden="true" {...stylex.props(styles.metaDot)}>
                ·
              </span>
            ) : null}
          </>
        ) : null}
        {location ? (
          <span {...stylex.props(styles.branch)} title={location}>
            {location}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <div
      role="listitem"
      {...stylex.props(styles.row, selected && styles.rowSelected)}
      // Depth is data, not a design token: four roots and a few nested
      // submodules must each get their own indent without a fixed ladder.
      style={{ paddingInlineStart: 4 + row.depth * 14 }}
    >
      <Glyph aria-hidden="true" {...stylex.props(styles.glyph)} />
      {onSelect ? (
        <button
          type="button"
          aria-label={label}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
          {...stylex.props(styles.select)}
        >
          {content}
        </button>
      ) : (
        <span {...stylex.props(styles.select, styles.selectStatic)}>{content}</span>
      )}
      {pending ? (
        <Tooltip.Root>
          <Tooltip.Trigger
            render={<span role="img" aria-label={pending} {...stylex.props(styles.state)} />}
          />
          <Tooltip.Content side="top">{pending}</Tooltip.Content>
        </Tooltip.Root>
      ) : (
        <span aria-hidden="true" />
      )}
      <span {...stylex.props(styles.prSlot)}>
        {row.pr && statusMeta ? (
          <button
            type="button"
            {...stylex.props(styles.pr)}
            aria-label={t('sessions.projectMembers.openPr', 'Open pull request #{{number}}', {
              number: row.pr.number,
            })}
            onClick={() => {
              // Opening a PR from the panel also makes its repository the one
              // the stage and PR tab describe.
              onSelect?.();
              onOpenPullRequest(row.pr!.url);
            }}
          >
            <statusMeta.icon
              aria-hidden="true"
              className={cn(stylex.props(styles.prIcon).className, statusMeta.iconColorClassName)}
            />
            <span>#{row.pr.number}</span>
            {ciStyle ? (
              <span aria-hidden="true" {...stylex.props(styles.ci, styles[ciStyle])} />
            ) : null}
          </button>
        ) : (
          // A directory used in place never has one; saying "No PR" would
          // suggest it could.
          <span {...stylex.props(styles.noPr)}>
            {inPlace ? '' : t('sessions.projectMembers.noPr', 'No PR')}
          </span>
        )}
      </span>
    </div>
  );
}
