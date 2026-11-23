import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { ProjectSkillScope } from '@lody/shared';
import { Badge } from '@lody/ui/badge';

/* Shared skill badges used by the desktop Skills tab, the mobile sheet, the `$`
   mention detail panel, and the skill detail dialog. They are `@lody/ui` badges,
   which have one size: `size` is kept so callers that state a density still
   compile, and no longer changes the chip. Pass `className` for layout-only
   tweaks (e.g. `shrink-0`). */
type SkillBadgeSize = 'sm' | 'md';

const styles = stylex.create({
  version: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
});

export function SkillScopeBadge({
  scope,
  className,
}: {
  scope: ProjectSkillScope;
  size?: SkillBadgeSize;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Badge className={className}>
      {scope === 'system'
        ? t('workspace.projects.skills.scopeSystem', 'System')
        : scope === 'global'
          ? t('workspace.projects.skills.scopeGlobal', 'Global')
          : t('workspace.projects.skills.scopeProject', 'Project')}
    </Badge>
  );
}

export function SkillVersionBadge({
  version,
  className,
}: {
  version: string;
  size?: SkillBadgeSize;
  className?: string;
}) {
  return (
    <Badge className={className}>
      <span {...stylex.props(styles.version)}>v{version}</span>
    </Badge>
  );
}

export function SkillSymlinkBadge({
  symlinkTarget,
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
    <Badge className={className} title={title} icon={<Link2 size="100%" />}>
      {t('workspace.projects.skills.symlink', 'Symlink')}
    </Badge>
  );
}
