import {
  PromptShortcutTargetSchema,
  type PromptShortcutMention,
} from '@lody/shared/prompt-shortcuts/model';
import type { PersistedMentionRange } from './mention-persistence';

/** Pure editor serialization. Importing this must not activate any mention source. */
export function shortcutMentionRanges(
  mentions: readonly PromptShortcutMention[]
): PersistedMentionRange[] {
  return mentions.map((mention) => ({
    start: mention.start,
    end: mention.end,
    value: JSON.stringify(mention.target),
    kind:
      mention.target.kind === 'pull_request'
        ? 'pr'
        : mention.target.kind === 'file' && mention.target.directory
          ? 'dir'
          : mention.target.kind,
  }));
}
export function shortcutTemplateMentions(
  text: string,
  ranges: readonly PersistedMentionRange[]
): PromptShortcutMention[] {
  return ranges.map((range) => ({
    start: range.start,
    end: range.end,
    label: text.slice(range.start, range.end),
    target: PromptShortcutTargetSchema.parse(JSON.parse(range.value)),
  }));
}
