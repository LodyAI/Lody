/**
 * The sidebar's "opened by" tree. The implementation lives in `@lody/shared`
 * so the Status view layout and every phone surface nest rows the same way.
 */
export {
  buildOpenedBySessionTree,
  countOpenedByTreeRoots,
  getPinnedSessionTreeIds,
  hasOpenedByTreeNesting,
  normalizeSessionRowId,
  pinnedFirstRootRank,
  placeOpenedSessionsWithOpeners,
  type BuildOpenedBySessionTreeOptions,
  type OpenedBySessionTreeNode,
} from '@lody/shared/status-view';
