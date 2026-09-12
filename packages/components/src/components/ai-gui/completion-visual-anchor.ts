export interface CompletionAnchorAdjustment {
  scrollTop: number;
  spacerHeight: number;
}

// `use-stick-to-bottom@1.1.6` treats <=70px as near-bottom and re-locks after
// negative content resizes. Keep one extra pixel while preserving an anchor.
const COMPLETION_ANCHOR_FOLLOW_GUARD_PX = 71;

export interface CompletionLayoutState {
  messageId: string | null;
  finished: boolean;
  activityVisible: boolean;
}

export const resolveCompletionContractionMessageId = (
  previous: CompletionLayoutState,
  current: CompletionLayoutState
): string | null =>
  current.messageId !== null &&
  previous.messageId === current.messageId &&
  ((!previous.finished && current.finished) ||
    (previous.activityVisible && !current.activityVisible))
    ? current.messageId
    : null;

export interface CompletionVisualAnchorSnapshot {
  messageId: string;
  rowKey: string | null;
  viewportOffset: number | null;
  scrollTop: number;
  provisionalSpacerHeight: number;
}

export const captureCompletionVisualAnchor = (
  scrollElement: HTMLDivElement,
  messageId: string,
  survivingRowKeys: ReadonlySet<string>
): CompletionVisualAnchorSnapshot => {
  const viewportRect = scrollElement.getBoundingClientRect();
  const candidates = Array.from(
    scrollElement.querySelectorAll<HTMLElement>('[data-chat-virtual-row-key]')
  )
    .flatMap((element) => {
      const rowKey = element.dataset.chatVirtualRowKey;
      if (rowKey === undefined || !survivingRowKeys.has(rowKey)) return [];
      const rect = element.getBoundingClientRect();
      return [{ rowKey, rect }];
    })
    .sort(
      (left, right) =>
        Math.abs(left.rect.top - viewportRect.top) - Math.abs(right.rect.top - viewportRect.top)
    );
  const visible = candidates.find(
    ({ rect }) => rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
  );
  const anchor = visible ?? candidates[0] ?? null;
  return {
    messageId,
    rowKey: anchor?.rowKey ?? null,
    viewportOffset: anchor === null ? null : anchor.rect.top - viewportRect.top,
    scrollTop: scrollElement.scrollTop,
    // The completion commit adds this before removing work/status rows, so the
    // browser always has enough range to avoid clamping the reader first.
    provisionalSpacerHeight: Math.max(1, scrollElement.scrollHeight),
  };
};

export const resolveCompletionAnchorAdjustment = ({
  currentScrollTop,
  oldAnchorOffset,
  newAnchorOffset,
  viewportHeight,
  scrollHeightWithSpacer,
  provisionalSpacerHeight,
}: {
  currentScrollTop: number;
  oldAnchorOffset: number | null;
  newAnchorOffset: number | null;
  viewportHeight: number;
  scrollHeightWithSpacer: number;
  provisionalSpacerHeight: number;
}): CompletionAnchorAdjustment => {
  const anchorDelta =
    oldAnchorOffset === null || newAnchorOffset === null ? 0 : newAnchorOffset - oldAnchorOffset;
  const scrollTop = Math.max(0, currentScrollTop + anchorDelta);
  const collapsedScrollHeight = Math.max(0, scrollHeightWithSpacer - provisionalSpacerHeight);
  return {
    scrollTop,
    spacerHeight: Math.max(
      0,
      Math.ceil(
        scrollTop + viewportHeight + COMPLETION_ANCHOR_FOLLOW_GUARD_PX - collapsedScrollHeight
      )
    ),
  };
};
