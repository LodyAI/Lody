import { renderShortcutSemanticMention, shortcutSemanticSpan } from './shortcut-semantic-mention';
import { shortcutInvocationAvailability } from './shortcut-composer-state';
import type { TFunction } from 'i18next';
import { shortcutAvailabilityMessage } from './mention-prompt-shortcut-source';
import { applyTextRewrites, type TextRewrite } from '@lody/shared';
import {
  expandShortcut,
  parseShortcutInvocation,
  PromptShortcutError,
  PROMPT_SHORTCUT_LIMITS,
  shortcutByteLength,
  validateShortcutRanges,
} from '@lody/shared/prompt-shortcuts';
import type { Mention } from '@/ui/mention/index';
import {
  type ShortcutMentionContext,
  type ShortcutDependencyResolver,
} from './mention-prompt-shortcut-source';
import { ShortcutSelectionUnavailable } from './shortcut-selection';

/** All edits address original composer coordinates; a single emitter produces final offsets. */
export function compileShortcutPrompt(input: {
  text: string;
  mentions: readonly Mention[];
  ordinaryRewrites: readonly TextRewrite[];
  context: ShortcutMentionContext | null;
  resolveDependency?: ShortcutDependencyResolver;
  maxBytes?: number;
}) {
  const chips = input.mentions.filter((mention) => mention.kind === 'prompt_shortcut');
  const baseRewrites = input.ordinaryRewrites;
  if (!chips.length) return applyTextRewrites(input.text, baseRewrites);
  validateShortcutRanges(
    input.text,
    [...input.mentions].sort((a, b) => a.start - b.start)
  );
  const ids = new Set<string>();
  const maxBytes = input.maxBytes ?? PROMPT_SHORTCUT_LIMITS.promptBytes;
  const rewrites: TextRewrite[] = chips.map((chip) => {
    const invocation = parseShortcutInvocation(chip.data);
    if (
      chip.value !== invocation.id ||
      ids.has(invocation.id) ||
      input.text.slice(chip.start, chip.end) !== `/${invocation.snapshot.slug}`
    )
      throw new PromptShortcutError('invalid_ranges', 'Incomplete or stale invocation range');
    ids.add(invocation.id);
    const availability = shortcutInvocationAvailability(
      invocation,
      input.context,
      input.resolveDependency
    );
    if (availability.kind !== 'available') throw new ShortcutSelectionUnavailable(availability);
    const expanded = expandShortcut(invocation, maxBytes, renderShortcutSemanticMention);
    return {
      start: chip.start,
      end: chip.end,
      replacement: expanded.text,
      spans: expanded.mentions.map(shortcutSemanticSpan),
    };
  });
  const ordinary = baseRewrites.filter(
    (rewrite) => !chips.some((chip) => rewrite.start < chip.end && rewrite.end > chip.start)
  );
  const result = applyTextRewrites(input.text, [...ordinary, ...rewrites]);
  if (shortcutByteLength(result.text) > maxBytes)
    throw new PromptShortcutError('size_limit', 'Expanded prompt exceeds the message byte limit');
  return result;
}

export function shortcutCompilationErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ShortcutSelectionUnavailable)
    return shortcutAvailabilityMessage(error.availability, t);
  if (error instanceof PromptShortcutError && error.code === 'size_limit')
    return t('promptShortcut.promptTooLarge');
  return t('promptShortcut.invalidDraft');
}
