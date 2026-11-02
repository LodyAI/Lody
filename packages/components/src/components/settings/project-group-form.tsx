import { useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Folder, FolderGit2, GitBranch, Github } from 'lucide-react';
import type { ProjectMemberId } from '@lody/shared';
import type { ProjectGroupFormValue, ProjectGroupMemberDraft } from '@/lib/project-group-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Section } from './form-primitives';
import { settingsRecordsCard } from './compact-layout';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  member: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[1.5],
    paddingInline: space[3],
  },
  // Submodules sit under their parent the way they sit on disk, one step
  // further in per level.
  memberIndent: (depth: number) => ({ paddingInlineStart: `${12 + depth * 20}px` }),
  memberBody: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    gap: '2px',
    minWidth: 0,
  },
  memberName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    color: colors.label,
  },
  memberDetail: {
    minWidth: 0,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  memberPath: {
    flexShrink: 0,
    maxWidth: '40%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  instructions: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    fontSize: text.footnoteSize,
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
});

/** Members in the order their directories nest: each parent, then its submodules. */
function orderAsTree(members: readonly ProjectGroupMemberDraft[]) {
  const children = new Map<ProjectMemberId, ProjectGroupMemberDraft[]>();
  const roots: ProjectGroupMemberDraft[] = [];
  const ids = new Set(members.map((member) => member.id));
  for (const member of members) {
    const placement = member.placement;
    if (placement.kind === 'submodule' && ids.has(placement.parent)) {
      const list = children.get(placement.parent) ?? [];
      list.push(member);
      children.set(placement.parent, list);
    } else roots.push(member);
  }
  const ordered: { member: ProjectGroupMemberDraft; depth: number; path: string }[] = [];
  const seen = new Set<ProjectMemberId>();
  const visit = (member: ProjectGroupMemberDraft, depth: number, prefix: string) => {
    if (seen.has(member.id)) return;
    seen.add(member.id);
    const own =
      member.placement.kind === 'root'
        ? member.placement.dir
        : `${prefix}${member.placement.path}`.replace(/^\//, '');
    ordered.push({ member, depth, path: own });
    for (const child of children.get(member.id) ?? []) visit(child, depth + 1, `${own}/`);
  };
  for (const member of roots) visit(member, 0, '');
  // A cycle leaves members unvisited; show them flat so nothing disappears.
  for (const member of members) visit(member, 0, '');
  return ordered;
}

/**
 * A project someone else created, as it is: its members where they sit in a
 * conversation's directory, and its instructions. Creating and editing go
 * through `ProjectCreateWizard`; this view changes nothing.
 */
export function ProjectGroupView({
  value,
  labelOf,
  detailOf,
  onClose,
}: {
  value: ProjectGroupFormValue;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => orderAsTree(value.members), [value.members]);
  return (
    <div {...stylex.props(catalog.editorForm)}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <Section title={t('settings.projectGroups.form.members')}>
          <div {...stylex.props(settingsRecordsCard)}>
            {rows.map(({ member, depth, path }, index) => (
              <div
                key={member.id}
                {...stylex.props(
                  surface.line,
                  index > 0 && surface.lineRuled,
                  styles.member,
                  styles.memberIndent(depth)
                )}
              >
                <MemberIcon member={member} />
                <span {...stylex.props(styles.memberBody)}>
                  <span {...stylex.props(styles.memberName)}>{labelOf(member)}</span>
                  {detailOf(member) ? (
                    <span {...stylex.props(styles.memberDetail)}>{detailOf(member)}</span>
                  ) : null}
                </span>
                <span {...stylex.props(styles.memberPath)} title={path}>
                  {path}
                </span>
              </div>
            ))}
          </div>
        </Section>
        {value.instructions.trim() ? (
          <Section title={t('settings.projectGroups.form.instructions')}>
            <p {...stylex.props(styles.instructions)}>{value.instructions}</p>
          </Section>
        ) : null}
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </Dialog.Footer>
    </div>
  );
}

/** A submodule, a folder on one machine, a repository with a local copy, or a GitHub one. */
function MemberIcon({ member }: { member: ProjectGroupMemberDraft }) {
  const Icon =
    member.placement.kind === 'submodule'
      ? GitBranch
      : member.source.kind === 'local'
        ? Folder
        : member.source.preferLocal
          ? FolderGit2
          : Github;
  return <Icon aria-hidden="true" {...stylex.props(catalog.icon)} />;
}
