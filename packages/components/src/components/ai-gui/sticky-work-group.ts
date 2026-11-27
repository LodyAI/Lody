/**
 * Sticky work-group summary tracking for virtualized conversation streams.
 *
 * The conversation scroll engine renders every row as a flat, absolutely
 * positioned sibling inside a virtualized viewport (`EngineConversationScroller`),
 * so expanded work-group headers (`WorkedGroupHeader` and `ActivityGroupHeader`)
 * can be unmounted once scrolled past the overscan buffer. This module resolves
 * the active expanded group and its push-up offset purely from row metadata and
 * the scroll handle's item-space geometry.
 */

export type StickyWorkGroupRow =
  | {
      type: 'assistant';
      key: string;
      item: { message: { id: string } };
      isWorkedDetail?: boolean;
      content:
        | { kind: 'worked_group_header'; segmentKey: string; expanded: boolean }
        | {
            kind: 'activity_group_header';
            block: { key: string };
            segmentKey: string;
            expanded: boolean;
          }
        | { kind: 'activity_detail'; groupKey: string }
        | { kind: 'footer' }
        | { kind: 'plan' }
        | { kind: 'subagent_tasks' }
        | { kind: 'coordinator_bubble' }
        | { kind: 'coordinator_card' }
        | { kind: 'coordinator_notice' }
        | { kind: 'content' };
    }
  | {
      type: 'standard' | 'placeholder' | 'local-user';
      key: string;
    };

export interface StickyWorkGroupRange {
  /** Stable key of the header virtual row (`row.key`). */
  rowKey: string;
  /** Index of the header row inside `virtualRows` (before `leadingRowCount`). */
  headerRowIndex: number;
  /** Index of the last body row inside `virtualRows` (strictly greater than `headerRowIndex`). */
  lastBodyRowIndex: number;
  /** Nesting depth: 0 for worked groups or standalone activity groups; 1 for nested activity groups. */
  depth: 0 | 1;
  /** Row index of the enclosing expanded worked-group header, or null when top-level. */
  parentHeaderRowIndex: number | null;
}

export interface ActiveStickyWorkGroup {
  group: StickyWorkGroupRange;
  /** Vertical push offset in pixels (`<= 0`): 0 while pinned, negative while pushing out. */
  pushOffsetPx: number;
}

const STICKY_EDGE_EPSILON_PX = 0.5;
const FALLBACK_STICKY_BAR_HEIGHT_PX = 36;

/**
 * Extract every expanded work-group header and its contiguous foldable body span.
 *
 * A worked group's span stops at the first row outside `isWorkedDetail` (such as
 * a final answer, plan surface, or footer) so the sticky header never occludes
 * non-folded conversation prose. Collapsed groups and empty groups are omitted.
 */
export function collectStickyWorkGroups(
  rows: readonly StickyWorkGroupRow[]
): StickyWorkGroupRange[] {
  const groups: StickyWorkGroupRange[] = [];
  let activeWorkedMessageId: string | null = null;
  let activeWorkedHeaderIndex: number | null = null;
  let activeWorkedLastBodyIndex = -1;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.type !== 'assistant') {
      activeWorkedMessageId = null;
      activeWorkedHeaderIndex = null;
      activeWorkedLastBodyIndex = -1;
      continue;
    }

    const messageId = row.item.message.id;
    if (
      activeWorkedHeaderIndex !== null &&
      (messageId !== activeWorkedMessageId || index > activeWorkedLastBodyIndex)
    ) {
      activeWorkedMessageId = null;
      activeWorkedHeaderIndex = null;
      activeWorkedLastBodyIndex = -1;
    }

    if (row.content.kind === 'worked_group_header') {
      activeWorkedMessageId = null;
      activeWorkedHeaderIndex = null;
      activeWorkedLastBodyIndex = -1;
      if (!row.content.expanded) continue;

      let lastBodyRowIndex = index;
      for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
        const next = rows[nextIndex];
        if (
          !next ||
          next.type !== 'assistant' ||
          next.item.message.id !== messageId ||
          next.content.kind === 'worked_group_header' ||
          next.content.kind === 'footer' ||
          next.isWorkedDetail !== true
        ) {
          break;
        }
        lastBodyRowIndex = nextIndex;
      }

      if (lastBodyRowIndex > index) {
        groups.push({
          rowKey: row.key,
          headerRowIndex: index,
          lastBodyRowIndex,
          depth: 0,
          parentHeaderRowIndex: null,
        });
        activeWorkedMessageId = messageId;
        activeWorkedHeaderIndex = index;
        activeWorkedLastBodyIndex = lastBodyRowIndex;
      }
      continue;
    }

    if (row.content.kind === 'activity_group_header') {
      if (!row.content.expanded) continue;
      const groupKey = row.content.block.key;
      let lastBodyRowIndex = index;
      for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
        const next = rows[nextIndex];
        if (
          !next ||
          next.type !== 'assistant' ||
          next.item.message.id !== messageId ||
          next.content.kind !== 'activity_detail' ||
          next.content.groupKey !== groupKey
        ) {
          break;
        }
        lastBodyRowIndex = nextIndex;
      }

      if (lastBodyRowIndex > index) {
        const isNested =
          activeWorkedHeaderIndex !== null &&
          activeWorkedMessageId === messageId &&
          index <= activeWorkedLastBodyIndex &&
          row.isWorkedDetail === true;
        groups.push({
          rowKey: row.key,
          headerRowIndex: index,
          lastBodyRowIndex,
          depth: isNested ? 1 : 0,
          parentHeaderRowIndex: isNested ? activeWorkedHeaderIndex : null,
        });
      }
    }
  }

  return groups;
}

/**
 * Determine which expanded work group (if any) should be pinned below the
 * session header at the current scroll position, and how far it is pushed up
 * as its body ends or the next expanded work group approaches.
 */
export function resolveActiveStickyWorkGroup({
  groups,
  leadingRowCount,
  scrollOffset,
  contentOffset,
  topInsetPx,
  stickyBarHeight,
  getItemOffset,
  getItemSize,
}: {
  groups: readonly StickyWorkGroupRange[];
  leadingRowCount: number;
  scrollOffset: number;
  contentOffset: number;
  topInsetPx: number;
  stickyBarHeight: number;
  getItemOffset: (listIndex: number) => number;
  getItemSize: (listIndex: number) => number;
}): ActiveStickyWorkGroup | null {
  if (groups.length === 0) return null;

  const stickyLine = scrollOffset - contentOffset + topInsetPx;
  const rowTop = (rowIndex: number) => getItemOffset(rowIndex + leadingRowCount);
  const rowSize = (rowIndex: number) => getItemSize(rowIndex + leadingRowCount);
  const rowBottom = (rowIndex: number) => rowTop(rowIndex) + rowSize(rowIndex);

  let active: StickyWorkGroupRange | null = null;
  let activeHeaderHeight = 0;
  let activeEnd = 0;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const headerTop = rowTop(group.headerRowIndex);
    if (headerTop >= stickyLine - STICKY_EDGE_EPSILON_PX) {
      // Groups are ordered by ascending headerRowIndex, so later groups cannot
      // have scrolled past `stickyLine` either.
      break;
    }
    const headerHeight = rowSize(group.headerRowIndex);
    const groupEnd = rowBottom(group.lastBodyRowIndex);
    if (groupEnd <= stickyLine + STICKY_EDGE_EPSILON_PX) continue;
    if (groupEnd <= headerTop + headerHeight + STICKY_EDGE_EPSILON_PX) continue;

    if (!active || group.depth >= active.depth) {
      active = group;
      activeHeaderHeight = headerHeight;
      activeEnd = groupEnd;
    }
  }

  if (!active) return null;

  const effectiveBarHeight =
    stickyBarHeight > 0
      ? stickyBarHeight
      : Math.max(FALLBACK_STICKY_BAR_HEIGHT_PX, activeHeaderHeight);

  let boundaryY = activeEnd - stickyLine;
  for (let index = 0; index < groups.length; index += 1) {
    const candidate = groups[index]!;
    if (candidate.headerRowIndex <= active.headerRowIndex) continue;
    const candidateTop = rowTop(candidate.headerRowIndex);
    if (candidateTop < stickyLine) continue;
    boundaryY = Math.min(boundaryY, candidateTop - stickyLine);
    break;
  }

  const pushOffsetPx =
    boundaryY < effectiveBarHeight
      ? Math.max(-effectiveBarHeight, boundaryY - effectiveBarHeight)
      : 0;

  return { group: active, pushOffsetPx };
}

/**
 * Target screen Y (relative to the conversation stream root) where a collapsed
 * inline header should land when collapsed from the sticky control bar.
 *
 * Top-level groups land directly at `topInsetPx`. A nested activity group inside
 * an expanded worked group lands right below the parent sticky header (or directly
 * under the parent's inline header if they are adjacent) so the parent sticky bar
 * never covers the just-collapsed row.
 */
export function resolveStickyCollapseTargetScreenY({
  group,
  leadingRowCount,
  topInsetPx,
  stickyBarHeight,
  getItemOffset,
}: {
  group: StickyWorkGroupRange;
  leadingRowCount: number;
  topInsetPx: number;
  stickyBarHeight: number;
  getItemOffset: (listIndex: number) => number;
}): number {
  if (group.parentHeaderRowIndex === null) return topInsetPx;
  const headerTop = getItemOffset(group.headerRowIndex + leadingRowCount);
  const parentTop = getItemOffset(group.parentHeaderRowIndex + leadingRowCount);
  const gap = Math.max(0, headerTop - parentTop);
  const effectiveBarHeight = stickyBarHeight > 0 ? stickyBarHeight : FALLBACK_STICKY_BAR_HEIGHT_PX;
  return topInsetPx + Math.min(effectiveBarHeight, gap);
}
