import { useMemo } from 'react';
import type { ProjectRef } from '@lody/shared';
import {
  UNIFIED_PROJECT_OPTION_RENDER_LIMIT,
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
  type UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';
import { cn } from '@/lib/utils';
import {
  projectRefToUnifiedSelection,
  unifiedSelectionToProjectRef,
} from './project-ref-selection';
import type { CSSProperties } from 'react';

export type ProjectRefSelectorProps = {
  menuClassName?: string;
  menuStyle?: CSSProperties;
  value: ProjectRef | null;
  onChange: (next: ProjectRef | null) => void;
  localProjects: ReadonlyArray<UnifiedLocalProjectOption>;
  repositories?: ReadonlyArray<{ fullName: string; description?: string | null }>;
  latestMessageAtByRepo?: ReadonlyMap<string, number>;
  onAddLocalProject: () => void;
  onConnectGitRepo: () => void;
  className?: string;
  /** Defaults to `bottom` — task surfaces open downward from the trigger. */
  contentSide?: 'top' | 'bottom';
  /** `property-row` for the detail rail; `chip` for capture / toolbar. */
  triggerVariant?: 'chip' | 'property-row';
};

/**
 * Task-facing wrapper around the chat landing project picker.
 *
 * Tasks store a `ProjectRef` (no machine id on local refs); the unified
 * selector works in `UnifiedProjectSelection`. Conversion stays here so every
 * task surface (detail properties rail, quick-add, launch controls) sees the
 * same searchable menu rather than a private truncated dropdown.
 */
export function ProjectRefSelector({
  menuClassName,
  menuStyle,
  value,
  onChange,
  localProjects,
  repositories,
  latestMessageAtByRepo,
  onAddLocalProject,
  onConnectGitRepo,
  className,
  contentSide = 'bottom',
  triggerVariant = 'chip',
}: ProjectRefSelectorProps) {
  const selection = useMemo(
    () => projectRefToUnifiedSelection(value, localProjects),
    [localProjects, value]
  );

  const handleChange = (next: UnifiedProjectSelection) => {
    onChange(unifiedSelectionToProjectRef(next));
  };

  return (
    <UnifiedProjectSelectorView
      value={selection}
      onChange={handleChange}
      localProjects={localProjects}
      repositories={repositories}
      latestMessageAtByRepo={latestMessageAtByRepo}
      onAddLocalProject={onAddLocalProject}
      onConnectGitRepo={onConnectGitRepo}
      contentSide={contentSide}
      triggerVariant={triggerVariant}
      className={cn(className)}
      contentClassName={menuClassName}
      contentStyle={menuStyle}
      renderLimit={latestMessageAtByRepo ? UNIFIED_PROJECT_OPTION_RENDER_LIMIT : undefined}
    />
  );
}
