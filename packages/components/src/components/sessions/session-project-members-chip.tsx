import * as stylex from '@stylexjs/stylex';
import { Folders, Folder, GitBranch, Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectMemberId, SessionPullRequestCiState } from '@lody/shared';
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
  pr: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '3px',
    minWidth: 0,
    flexShrink: 0,
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    ':hover': { textDecoration: 'underline' },
  },
  prIcon: { width: '12px', height: '12px', flexShrink: 0 },
  hint: {
    padding: `${space[1.5]} ${space[2]}`,
    borderTop: `1px solid ${colors.separator}`,
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
});

/**
 * CI rides on the PR glyph, whose SHAPE already carries the PR status. This
 * keeps the row to one status mark instead of stacking a second colored dot
 * beside the number. Unreported CI leaves the glyph in its PR-status color.
 */
const CI_ICON_TONE: Partial<Record<SessionPullRequestCiState, string>> = {
  s: 'text-status-success',
  f: 'text-destructive',
  e: 'text-destructive',
  p: 'text-status-warning',
};

function getCiLabel(
  t: ReturnType<typeof useTranslation>['t'],
  ciState: SessionPullRequestCiState | undefined
): string | null {
  switch (ciState) {
    case 's':
      return t('sessions.prCi.passing', 'CI passed');
    case 'p':
      return t('sessions.prCi.running', 'CI running');
    case 'f':
    case 'e':
      return t('sessions.prCi.failing', 'CI failed');
    default:
      return null;
  }
}

/**
 * The repositories of a multi-repository conversation, one click away.
 *
 * A plain cluster action like Related sessions: it never takes the stage.
 * Each row says where the repository sits, its branch, and its current PR
 * (when there is one). Rows are indented by placement depth; selecting one
 * makes the context stage describe that repository (its branch, path, diff
 * and PR) instead of the first Member.
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
  const statusMeta = row.pr ? PR_STATUS_META[row.pr.status] : null;
  const ciTone = row.pr?.ciState ? CI_ICON_TONE[row.pr.ciState] : undefined;
  const ciLabel = getCiLabel(t, row.pr?.ciState);
  const identity = row.repoFullName ?? row.path;
  const inPlaceHint = inPlace
    ? t('sessions.projectMembers.inPlace', 'Original directory · not isolated')
    : undefined;
  const location = inPlace ? (row.localRootPath ?? inPlaceHint) : (row.branch ?? '');
  const locationTitle = [location, inPlace && row.localRootPath ? inPlaceHint : null]
    .filter(Boolean)
    .join(' · ');
  const showPath = Boolean(row.repoFullName && row.repoFullName !== row.path);
  const label = [identity, row.path, locationTitle].filter(Boolean).join(' · ');
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
          <span {...stylex.props(styles.branch)} title={locationTitle}>
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
      {row.pr && statusMeta ? (
        <button
          type="button"
          {...stylex.props(styles.pr)}
          aria-label={`${t('sessions.projectMembers.openPr', 'Open pull request #{{number}}', {
            number: row.pr.number,
          })}${ciLabel ? ` · ${ciLabel}` : ''}`}
          onClick={() => {
            // Opening a PR from the panel also makes its repository the one
            // the stage and PR tab describe.
            onSelect?.();
            onOpenPullRequest(row.pr!.url);
          }}
        >
          <statusMeta.icon
            aria-hidden="true"
            className={cn(
              stylex.props(styles.prIcon).className,
              ciTone ?? statusMeta.iconColorClassName
            )}
          />
          <span>#{row.pr.number}</span>
        </button>
      ) : null}
    </div>
  );
}
