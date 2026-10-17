import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, Folder, GitBranch, Github } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectMember, ProjectMemberId } from '@lody/shared';
import { collectProjectSubmoduleDescendants } from '@/lib/project-group-form';
import { selectProjectGroupMembers } from '@/lib/project-group-launch';
import { Menu } from '@lody/ui/menu';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
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
  row: { display: 'flex', alignItems: 'center', gap: space[1.5], minWidth: 0 },
  // A submodule sits under its parent, as it will on disk.
  nested: { paddingInlineStart: space[4] },
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  path: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
});

export type ProjectGroupMemberPickerProps = {
  members: readonly ProjectMember[];
  excluded: ReadonlySet<ProjectMemberId>;
  onExcludedChange: (excluded: ReadonlySet<ProjectMemberId>) => void;
  labelOf: (member: ProjectMember) => string;
  disabled?: boolean;
};

/**
 * Which of a Project group's repositories this conversation uses.
 *
 * Every member starts ticked. Unticking a parent unticks its submodules too —
 * a submodule is checked out inside its parent — and the count on the face
 * says how many repositories the conversation will get.
 */
export function ProjectGroupMemberPicker({
  members,
  excluded,
  onExcludedChange,
  labelOf,
  disabled = false,
}: ProjectGroupMemberPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => new Set(selectProjectGroupMembers({ members: [...members] }, excluded).map((m) => m.id)),
    [excluded, members]
  );
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

  const toggle = (member: ProjectMember, checked: boolean) => {
    const next = new Set(excluded);
    if (checked) {
      next.delete(member.id);
      // Ticking a submodule brings back the parent it lives in.
      let placement = member.placement;
      while (placement.kind === 'submodule') {
        const parentId = placement.parent;
        next.delete(parentId);
        placement = members.find((candidate) => candidate.id === parentId)?.placement ?? {
          kind: 'root',
          dir: '',
        };
      }
    } else {
      next.add(member.id);
      for (const child of collectProjectSubmoduleDescendants(members, member.id)) next.add(child);
    }
    onExcludedChange(next);
  };

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        disabled={disabled}
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
          {t('chat.projectGroup.membersCount', '{{selected}}/{{total}} repositories', {
            selected: selected.size,
            total: members.length,
          })}
        </span>
        <ChevronDown aria-hidden="true" {...stylex.props(composerSurface.chevron)} />
      </Menu.Trigger>
      <Menu.Content side="top" align="start">
        {ordered.map(({ member, depth }) => {
          const Icon =
            member.placement.kind === 'submodule'
              ? GitBranch
              : member.source.kind === 'github'
                ? Github
                : Folder;
          const path =
            member.placement.kind === 'root' ? `${member.placement.dir}/` : member.placement.path;
          return (
            <Menu.CheckboxItem
              key={member.id}
              checked={selected.has(member.id)}
              closeOnClick={false}
              onCheckedChange={(checked) => toggle(member, checked)}
            >
              <span {...stylex.props(styles.row, depth > 0 && styles.nested)}>
                <Icon aria-hidden="true" {...stylex.props(composerSurface.glyph14)} />
                <span {...stylex.props(styles.label)}>{labelOf(member)}</span>
                <span {...stylex.props(styles.path)}>{path}</span>
              </span>
            </Menu.CheckboxItem>
          );
        })}
      </Menu.Content>
    </Menu.Root>
  );
}
