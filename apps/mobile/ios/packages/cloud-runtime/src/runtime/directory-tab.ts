export function tabOwner(
  id: string,
  read: (id: string) => Record<string, unknown> | undefined,
) {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const value = read(id);
    if (!value || value.isArchived === true)
      throw new Error('tab_owner_unavailable');
    if (typeof value.parentSessionId !== 'string' || !value.parentSessionId)
      return { id, value };
    id = value.parentSessionId;
  }
  throw new Error('invalid_tab_family');
}
