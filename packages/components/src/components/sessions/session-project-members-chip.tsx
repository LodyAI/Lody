import * as stylex from '@stylexjs/stylex';
import { Folders, Folder, GitBranch, Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionPullRequestCiState } from '@lody/shared';
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
  list: { maxHeight: 320, overflowY: 'auto', padding: space[1], minWidth: 340 },
  // Every row is one line: path, branch, then fixed slots for state and PR,
  // so a repository changing state never changes the row's height or shape.
  row: {
    display: 'grid',
    gridTemplateColumns: '14px minmax(0, max-content) minmax(0, 1fr) 14px 64px',
    alignItems: 'center',
    columnGap: space[2],
    height: '28px',
    paddingInline: space[1.5],
    borderRadius: '6px',
    fontSize: text.footnoteSize,
  },
  glyph: { width: '14px', height: '14px', color: colors.tertiaryLabel },
  path: {
    color: colors.label,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  branch: {
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  state: {
    width: '8px',
    height: '8px',
    marginInline: 'auto',
    borderRadius: '50%',
    backgroundColor: colors.warning,
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
  noPr: { justifySelf: 'end', color: colors.tertiaryLabel },
  ci: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0 },
  ciSuccess: { backgroundColor: colors.success },
  ciFailure: { backgroundColor: colors.destructive },
  ciPending: { backgroundColor: colors.tertiaryLabel },
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
 * A plain cluster action like Related sessions: it never takes the stage, and
 * the context stage keeps describing the first repository for its actions.
 * Each row says where the repository sits, its branch, whether it holds work
 * that is not on the remote yet, and its current PR.
 */
export function SessionProjectMembersChip({
  groupName,
  rows,
  onOpenPullRequest,
  defaultOpen,
}: {
  groupName: string;
  rows: readonly SessionProjectMemberRow[];
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
      content={
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
              <MemberRow key={row.id} row={row} onOpenPullRequest={onOpenPullRequest} />
            ))}
          </div>
        </div>
      }
    />
  );
}

function MemberRow({
  row,
  onOpenPullRequest,
}: {
  row: SessionProjectMemberRow;
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
  return (
    <div role="listitem" {...stylex.props(styles.row)}>
      <Glyph aria-hidden="true" {...stylex.props(styles.glyph)} />
      <span {...stylex.props(styles.path)} title={row.repoFullName ?? row.path}>
        {row.path}
      </span>
      {inPlace ? (
        <span {...stylex.props(styles.branch)}>
          {t('sessions.projectMembers.inPlace', 'Original directory · not isolated')}
        </span>
      ) : (
        <span {...stylex.props(styles.branch)} title={row.branch}>
          {row.branch ?? ''}
        </span>
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
      {row.pr && statusMeta ? (
        <button
          type="button"
          {...stylex.props(styles.pr)}
          aria-label={t('sessions.projectMembers.openPr', 'Open pull request #{{number}}', {
            number: row.pr.number,
          })}
          onClick={() => onOpenPullRequest(row.pr!.url)}
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
    </div>
  );
}
