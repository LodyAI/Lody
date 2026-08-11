import type { MessageContent } from '@lody/shared';

export const USER_TEXT_RENDER_LINE_LIMIT = 10;
export const USER_TEXT_RENDER_CHAR_LIMIT = 900;

export const shouldCollapseAssistantMessageItem = ({
  content,
  index,
  items,
  isTurnFinished,
}: {
  content: MessageContent;
  index: number;
  items: MessageContent[];
  isTurnFinished: boolean;
}): boolean => {
  const itemCount = items.length;
  const visibleTextIndex = getTextIndexBeforeTrailingNeverCollapsedItems(items);

  return (
    isTurnFinished &&
    itemCount > 1 &&
    index < itemCount - 1 &&
    index !== visibleTextIndex &&
    content.type !== 'image_group' &&
    content.type !== 'file' &&
    content.type !== 'plan' &&
    content.type !== 'goal' &&
    content.type !== 'proposed_plan' &&
    !(content.type === 'tool_call' && content.kind === 'switch_mode')
  );
};

/**
 * Items that are appended AFTER the assistant's answer and are themselves never
 * collapsed: generated images, and the "Exited Plan Mode" switch that closes a
 * plan turn. The answer before them is still the answer, so it must not be
 * demoted to process output just because it is no longer the last item.
 */
const isTrailingNeverCollapsedItem = (content: MessageContent | undefined): boolean =>
  content?.type === 'image_group' ||
  (content?.type === 'tool_call' && content.kind === 'switch_mode');

const getTextIndexBeforeTrailingNeverCollapsedItems = (items: MessageContent[]): number => {
  let index = items.length - 1;
  if (!isTrailingNeverCollapsedItem(items[index])) {
    return -1;
  }

  while (index >= 0 && isTrailingNeverCollapsedItem(items[index])) {
    index -= 1;
  }

  return items[index]?.type === 'text' ? index : -1;
};

// Copyable text = plain `text` answers plus `proposed_plan` markdown. The plan
// is the meaningful payload of a plan-only turn, so the message-footer copy
// button must pick it up to stay consistent with every other message's copy
// action (a plan-only message would otherwise show no footer copy button).
// Extend the dispatch here when another content variant carries copyable text.
const getCopyableItemText = (content: MessageContent): string =>
  content.type === 'text' ? content.text : content.type === 'proposed_plan' ? content.markdown : '';

export const getTextContentFromMessageItems = (items: MessageContent[]): string =>
  items
    .map(getCopyableItemText)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

export const hasTextContentFromMessageItems = (items: MessageContent[]): boolean =>
  items.some((content) => content.type === 'text' && content.text.trim().length > 0);

export const getUserTextRenderSlice = (text: string): { text: string; isTruncated: boolean } => {
  const charLimitEnd =
    text.length > USER_TEXT_RENDER_CHAR_LIMIT ? USER_TEXT_RENDER_CHAR_LIMIT : text.length;
  let lineBreakCount = 0;

  for (let index = 0; index < charLimitEnd; index += 1) {
    if (text.charCodeAt(index) !== 10) {
      continue;
    }

    lineBreakCount += 1;
    if (lineBreakCount >= USER_TEXT_RENDER_LINE_LIMIT) {
      return { text: text.slice(0, index), isTruncated: true };
    }
  }

  if (charLimitEnd < text.length) {
    return { text: text.slice(0, charLimitEnd), isTruncated: true };
  }

  return { text, isTruncated: false };
};

export const getVisibleAssistantTextContent = (
  items: MessageContent[],
  isTurnFinished: boolean
): string =>
  getTextContentFromMessageItems(
    items.filter(
      (content, index) =>
        !shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished,
        })
    )
  );
