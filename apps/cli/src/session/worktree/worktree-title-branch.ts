const MAX_BRANCH_LENGTH = 64;

/** A title is only a hint: an unrepresentable title leaves the ID branch alone. */
export function branchNameFromSessionTitle(title: string, sessionId: string): string | null {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;

  const suffix = sessionId
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 8);
  if (!suffix) return null;
  const prefix = 'lody/';
  const available = MAX_BRANCH_LENGTH - prefix.length - suffix.length - 1;
  const boundedSlug = slug.slice(0, available).replace(/-+$/g, '');
  return boundedSlug ? `${prefix}${boundedSlug}-${suffix}` : null;
}
