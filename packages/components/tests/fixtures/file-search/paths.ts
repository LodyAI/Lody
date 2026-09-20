/** Synthetic deterministic paths; no captured project data. */
export function makeFilePaths(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `packages/project-${i % 200}/src/components/feature-${i % 997}/nested-${i % 17}/${['Composer', 'SearchPanel', 'adapter', 'index', 'README'][i % 5]}-${i}.tsx`
  );
}
export const fileSearchQueries = ['a', 'comp', 'src/components', 'zz-no-match'];
