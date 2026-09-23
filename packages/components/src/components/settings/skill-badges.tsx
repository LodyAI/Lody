import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import type { ProjectSkillScope } from '@lody/shared';
import { cn } from '@/lib/utils';

/* Shared skill badges used by the desktop Skills tab, the mobile sheet, the `$`
   mention detail panel, and the skill detail dialog. `size` controls only the
   badge's padding density: 'sm' (px-1 py-0) for compact inline rows, 'md'
   (px-1.5 py-0.5) for the roomier detail view. Pass `className` for layout-only
   tweaks (e.g. `shrink-0`). */
type SkillBadgeSize = 'sm' | 'md';

const SKILL_BADGE_BASE = 'rounded-sm border border-border/70 text-[10px] text-muted-foreground';
const SKILL_BADGE_PADDING: Record<SkillBadgeSize, string> = {
  sm: 'px-1 py-0',
  md: 'px-1.5 py-0.5',
};

export function SkillScopeBadge({
  scope,
  size = 'md',
  className,
}: {
  scope: ProjectSkillScope;
  size?: SkillBadgeSize;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span className={cn(SKILL_BADGE_BASE, SKILL_BADGE_PADDING[size], 'font-normal', className)}>
      {scope === 'system'
        ? t('workspace.projects.skills.scopeSystem', 'System')
        : scope === 'global'
          ? t('workspace.projects.skills.scopeGlobal', 'Global')
          : t('workspace.projects.skills.scopeProject', 'Project')}
    </span>
  );
}

export function SkillVersionBadge({
  version,
  size = 'md',
  className,
}: {
  version: string;
  size?: SkillBadgeSize;
  className?: string;
}) {
  return (
    <span
      className={cn(
        SKILL_BADGE_BASE,
        SKILL_BADGE_PADDING[size],
        'font-mono tabular-nums',
        className
      )}
    >
      v{version}
    </span>
  );
}

export function SkillSymlinkBadge({
  symlinkTarget,
  size = 'md',
  withTooltip = true,
  className,
}: {
  symlinkTarget?: string;
  size?: SkillBadgeSize;
  /** Render the "Links to …" tooltip. Off where the target is already shown
     elsewhere (the mention detail panel lists it as its own row). */
  withTooltip?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const title = !withTooltip
    ? undefined
    : symlinkTarget
      ? t('workspace.projects.skills.symlinkTargetTitle', {
          defaultValue: 'Links to {{target}}',
          target: symlinkTarget,
        })
      : t('workspace.projects.skills.symlinkTitle', 'This skill is a symlink');
  return (
    <span
      className={cn(
        SKILL_BADGE_BASE,
        SKILL_BADGE_PADDING[size],
        'inline-flex items-center gap-0.5',
        className
      )}
      title={title}
    >
      <Link2 className="h-2.5 w-2.5" />
      {t('workspace.projects.skills.symlink', 'Symlink')}
    </span>
  );
}
