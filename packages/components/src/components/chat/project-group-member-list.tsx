import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, Folder, GitBranch, Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectMember, ProjectMemberId } from '@lody/shared';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { composerSurface } from '@/components/shared/composer-surface';
import { contextPill } from './context-pill-class';

const styles = stylex.create({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    height: '24px',
    minWidth: 0,
    paddingInline: space[2],
    borderRadius: '6px',
    borderWidth: 0,
    color: colors.label,
    fontSize: '0.9em',
    cursor: 'pointer',
    userSelect: 'none',
  },
  count: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  list: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: '240px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    fontSize: text.subheadlineSize,
    color: colors.label,
  },
  // A submodule sits under its parent, one step further in per level, as it
  // will on disk.
  nested: (depth: number) => ({ paddingInlineStart: `${depth * 16}px` }),
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  path: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  // What this machine lacks, after the path: one quiet phrase, never a badge.
  note: { flexShrink: 0, color: colors.tertiaryLabel, fontSize: text.footnoteSize },
  noteMissing: { color: colors.warning },
});

const NO_MEMBERS: ReadonlySet<ProjectMemberId> = new Set();

export type ProjectGroupMemberListProps = {
  members: readonly ProjectMember[];
  labelOf: (member: ProjectMember) => string;
  /** Repository members the selected machine holds no copy of. */
  missing?: ReadonlySet<ProjectMemberId>;
  /** Whether a missing member is cloned instead (managed); otherwise it blocks. */
  canClone?: boolean;
};

/**
 * The repositories a new conversation in this group gets: all of them, laid
 * out as on disk.
 *
 * Read-only by design. A conversation is created from the group as
 * configured — a submodule is checked out by its parent anyway, and a
 * different set belongs in the group's settings, not in each conversation.
 * The list only says what the selected machine will clone or lacks.
 */
export function ProjectGroupMemberList({
  members,
  labelOf,
  missing = NO_MEMBERS,
  canClone = true,
}: ProjectGroupMemberListProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => {
    const ids = new Set(members.map((member) => member.id));
    const roots = members.filter(
      (member) => member.placement.kind === 'root' || !ids.has(member.placement.parent)
    );
    const out: { member: ProjectMember; depth: number }[] = [];
    const visit = (member: ProjectMember, depth: number) => {
      out.push({ member, depth });
      for (const child of members) {
        if (child.placement.kind === 'submodule' && child.placement.parent === member.id) {
          visit(child, depth + 1);
        }
      }
    };
    for (const root of roots) visit(root, 0);
    return out;
  }, [members]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={t('chat.projectGroup.membersLabel', 'Repositories in this conversation')}
            {...stylex.props(
              styles.trigger,
              contextPill.surface,
              contextPill.interactive,
              open && contextPill.open
            )}
          />
        }
      >
        <span {...stylex.props(styles.count)}>
          {t('chat.projectGroup.membersTotal', '{{count}} repositories', {
            count: members.length,
          })}
        </span>
        <ChevronDown aria-hidden="true" {...stylex.props(composerSurface.chevron)} />
      </Popover.Trigger>
      <Popover.Content side="top" align="start">
        <div role="list" {...stylex.props(styles.list)}>
          {ordered.map(({ member, depth }) => {
            const Icon =
              member.placement.kind === 'submodule'
                ? GitBranch
                : member.source.kind === 'github'
                  ? Github
                  : Folder;
            const path =
              member.placement.kind === 'root' ? `${member.placement.dir}/` : member.placement.path;
            const isMissing = missing.has(member.id);
            return (
              <div
                key={member.id}
                role="listitem"
                {...stylex.props(styles.row, styles.nested(depth))}
              >
                <Icon aria-hidden="true" {...stylex.props(composerSurface.glyph14)} />
                <span {...stylex.props(styles.label)}>{labelOf(member)}</span>
                <span {...stylex.props(styles.path)}>{path}</span>
                {isMissing ? (
                  <span {...stylex.props(styles.note, !canClone && styles.noteMissing)}>
                    {canClone
                      ? t('chat.projectGroup.memberClone', 'Cloned on start')
                      : t('chat.projectGroup.memberMissing', 'Not on this machine')}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
