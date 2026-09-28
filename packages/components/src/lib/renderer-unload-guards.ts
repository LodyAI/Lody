/** Synchronous document guards shared by native exit preflight and beforeunload. */
const guards = new Set<() => boolean>();

export function registerRendererUnloadGuard(isDirty: () => boolean): () => void {
  guards.add(isDirty);
  return () => {
    guards.delete(isDirty);
  };
}

export function hasUnsavedRendererChanges(): boolean {
  return [...guards].some((isDirty) => isDirty());
}
