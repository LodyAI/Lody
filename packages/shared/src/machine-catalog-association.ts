import { MemoryAssociationSchema, type MemoryAssociation } from './memory-provider';
import { MachineCatalogError } from './machine-catalog';
import { historyValuesEqual } from './history-values-equal';

/** Authored fields are closed. Stored future fields stay in the original row,
 * while the receipt contains only the known public association. */
export function planMemoryAssociationWrite(
  current: unknown,
  input: MemoryAssociation,
  mode: 'link' | 'edit'
): { value?: Record<string, unknown>; association: MemoryAssociation } {
  const next = MemoryAssociationSchema.parse(input);
  if (current === undefined) {
    if (mode === 'edit') throw new MachineCatalogError('not_found');
    return { value: next, association: next };
  }
  const stored = MemoryAssociationSchema.strip().safeParse(current);
  if (
    !stored.success ||
    stored.data.machineId !== next.machineId ||
    stored.data.providerId !== next.providerId ||
    stored.data.memoryId !== next.memoryId
  )
    throw new MachineCatalogError('invalid_edit');
  if (mode === 'link') return { association: stored.data };
  const association = { ...stored.data, name: next.name, description: next.description };
  return {
    association,
    ...(historyValuesEqual(stored.data, association)
      ? {}
      : {
          value: {
            ...(current as Record<string, unknown>),
            name: next.name,
            description: next.description,
          },
        }),
  };
}
