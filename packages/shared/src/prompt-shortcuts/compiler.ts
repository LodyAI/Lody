import {
  PROMPT_SHORTCUT_LIMITS,
  PromptShortcutError,
  PromptShortcutSchema,
  getShortcutMentionScopeIssues,
  shortcutByteLength,
  type PromptShortcut,
  type PromptShortcutMention,
} from './model';
import { z } from 'zod';

export function validateShortcutRanges(
  text: string,
  ranges: readonly { start: number; end: number }[]
): void {
  let end = 0;
  const splitsSurrogate = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset]);
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < end ||
      range.end <= range.start ||
      range.end > text.length ||
      splitsSurrogate(range.start) ||
      splitsSurrogate(range.end)
    ) {
      throw new PromptShortcutError(
        'invalid_ranges',
        'Ranges must be ordered, disjoint UTF-16 boundaries'
      );
    }
    end = range.end;
  }
}

export function parsePromptShortcut(value: unknown): PromptShortcut {
  const result = PromptShortcutSchema.safeParse(value);
  if (!result.success) throw new PromptShortcutError('invalid_template', result.error.message);
  const shortcut = result.data;
  if (shortcutByteLength(JSON.stringify(shortcut)) > PROMPT_SHORTCUT_LIMITS.documentBytes) {
    throw new PromptShortcutError('size_limit', 'Shortcut document exceeds the byte limit');
  }
  if (shortcut.updatedAt < shortcut.createdAt)
    throw new PromptShortcutError('invalid_template', 'Invalid timestamps');
  if (
    shortcut.scope.project?.kind === 'local' &&
    shortcut.scope.machineId !== undefined &&
    shortcut.scope.project.machineId !== shortcut.scope.machineId
  ) {
    throw new PromptShortcutError('scope_mismatch', 'Local project belongs to another machine');
  }
  validateShortcutRanges(shortcut.prompt, shortcut.mentions);
  for (const mention of shortcut.mentions) {
    if (shortcut.prompt.slice(mention.start, mention.end) !== mention.label) {
      throw new PromptShortcutError(
        'invalid_ranges',
        'Mention label does not match its text range'
      );
    }
    const target = mention.target;
    if (
      target.kind === 'skill' &&
      ((target.source === 'project' && !target.project) ||
        (target.source !== 'project' &&
          (target.machineId === undefined || target.project !== undefined)) ||
        (target.project?.kind === 'local' &&
          target.machineId !== undefined &&
          target.machineId !== target.project.machineId))
    )
      throw new PromptShortcutError(
        'invalid_template',
        'Skill source is incomplete or contradictory'
      );
    const issues = getShortcutMentionScopeIssues(shortcut.scope, target);
    if (issues.length)
      throw new PromptShortcutError(
        issues[0].code,
        'Mention requires compatible explicit scope',
        issues.map((issue) => issue.axis)
      );
  }
  return shortcut;
}

export type ShortcutInvocation = {
  id: string;
  snapshot: PromptShortcut;
};

// Not strict: a draft stored before variables were removed still carries a
// `values` key, and dropping that key must not discard the whole draft.
const invocationSchema = z.object({
  id: z.string().min(1).max(200),
  snapshot: z.unknown(),
});

export function parseShortcutInvocation(value: unknown): ShortcutInvocation {
  const parsed = invocationSchema.safeParse(value);
  if (!parsed.success)
    throw new PromptShortcutError('invalid_template', 'Invalid shortcut invocation');
  return { id: parsed.data.id, snapshot: parsePromptShortcut(parsed.data.snapshot) };
}

export function createShortcutInvocation(id: string, value: unknown): ShortcutInvocation {
  return { id, snapshot: parsePromptShortcut(value) };
}

export type ExpandedShortcut = {
  text: string;
  mentions: PromptShortcutMention[];
};

/** Generate text and offsets together, from the frozen snapshot alone. */
export function expandShortcut(
  invocation: ShortcutInvocation,
  maxBytes = PROMPT_SHORTCUT_LIMITS.documentBytes,
  renderMention?: (mention: PromptShortcutMention) => string
): ExpandedShortcut {
  invocation = parseShortcutInvocation(invocation);
  const snapshot = invocation.snapshot;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new PromptShortcutError('size_limit', 'Invalid expansion byte budget');
  const semanticText = snapshot.mentions.map(
    (mention) => renderMention?.(mention) ?? mention.label
  );
  let expandedBytes = shortcutByteLength(snapshot.prompt);
  snapshot.mentions.forEach((mention, index) => {
    expandedBytes += shortcutByteLength(semanticText[index]!) - shortcutByteLength(mention.label);
  });
  // Measure first: reject before building an oversized string or allocating
  // its UTF-8 copy.
  if (expandedBytes > maxBytes)
    throw new PromptShortcutError('size_limit', 'Expanded Shortcut exceeds the byte limit');
  const result: ExpandedShortcut = { text: '', mentions: [] };
  let cursor = 0;
  snapshot.mentions.forEach((mention, index) => {
    result.text += snapshot.prompt.slice(cursor, mention.start);
    const start = result.text.length;
    result.text += semanticText[index]!;
    result.mentions.push({
      start,
      end: result.text.length,
      label: mention.label,
      target: mention.target,
    });
    cursor = mention.end;
  });
  result.text += snapshot.prompt.slice(cursor);
  return result;
}
