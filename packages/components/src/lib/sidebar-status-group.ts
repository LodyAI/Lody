import { isStatusTierCollapsedByDefault } from '@lody/shared';

/**
 * Effective collapse state for a sidebar bucket given the person's stored
 * override map; Status tiers fall back to the shared defaults.
 */
export function isSidebarBucketCollapsed(
  key: string,
  collapsedBuckets?: Readonly<Record<string, boolean | undefined>>
): boolean {
  const override = collapsedBuckets?.[key];
  if (typeof override === 'boolean') return override;
  return isStatusTierCollapsedByDefault(key);
}
