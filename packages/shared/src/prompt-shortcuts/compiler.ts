import {
  PROMPT_SHORTCUT_LIMITS,
  PromptShortcutError,
  PromptShortcutSchema,
  getShortcutMentionScopeIssues,
  shortcutByteLength,
  type PromptShortcut,
} from './model';

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
