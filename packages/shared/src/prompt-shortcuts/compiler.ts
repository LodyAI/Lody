import {
  PROMPT_SHORTCUT_LIMITS,
  PromptShortcutError,
  PromptShortcutSchema,
  getShortcutMentionScopeIssues,
  shortcutByteLength,
  type PromptShortcut,
  type PromptShortcutMention,
  type PromptShortcutVariable,
} from './model';
import { z } from 'zod';

export type ShortcutPlaceholder = { start: number; end: number; name: string; escaped: boolean };

export function parseShortcutPlaceholders(prompt: string): ShortcutPlaceholder[] {
  return [...prompt.matchAll(/(\\)?!\{([A-Za-z][A-Za-z0-9_-]{0,39})\}/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[2],
    escaped: Boolean(match[1]),
  }));
}

export function deriveShortcutVariables(
  prompt: string,
  existing: readonly PromptShortcutVariable[] = []
): PromptShortcutVariable[] {
  const defaults = new Map(existing.map((variable) => [variable.name, variable.defaultValue]));
  const names = [
    ...new Set(
      parseShortcutPlaceholders(prompt)
        .filter((item) => !item.escaped)
        .map((item) => item.name)
    ),
  ];
  return names.map((name) => {
    const defaultValue = defaults.get(name);
    return defaultValue === undefined ? { name } : { name, defaultValue };
  });
}

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
  const placeholders = parseShortcutPlaceholders(shortcut.prompt);
  validateShortcutRanges(shortcut.prompt, shortcut.mentions);
  for (const mention of shortcut.mentions) {
    if (shortcut.prompt.slice(mention.start, mention.end) !== mention.label) {
      throw new PromptShortcutError(
        'invalid_ranges',
        'Mention label does not match its text range'
      );
    }
    if (placeholders.some((item) => item.start < mention.end && item.end > mention.start)) {
      throw new PromptShortcutError('invalid_ranges', 'A placeholder cannot overlap a mention');
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
  const names = deriveShortcutVariables(shortcut.prompt).map((variable) => variable.name);
  if (
    shortcut.variables.length !== names.length ||
    shortcut.variables.some((variable, index) => variable.name !== names[index])
  ) {
    throw new PromptShortcutError(
      'invalid_template',
      'Variables must match unique placeholders in occurrence order'
    );
  }
  return shortcut;
}

export type ShortcutInvocation = {
  id: string;
  snapshot: PromptShortcut;
  values: Record<string, string>;
};

const invocationSchema = z
  .object({
    id: z.string().min(1).max(200),
    snapshot: z.unknown(),
    values: z.record(z.string(), z.string()),
  })
  .strict();

export function parseShortcutInvocation(value: unknown): ShortcutInvocation {
  const parsed = invocationSchema.safeParse(value);
  if (!parsed.success)
    throw new PromptShortcutError('invalid_template', 'Invalid shortcut invocation');
  const snapshot = parsePromptShortcut(parsed.data.snapshot);
  const names = new Set(snapshot.variables.map((variable) => variable.name));
  for (const [name, content] of Object.entries(parsed.data.values)) {
    if (!names.has(name))
      throw new PromptShortcutError(
        'invalid_template',
        'Invocation contains an undeclared variable'
      );
    if (shortcutByteLength(content) > PROMPT_SHORTCUT_LIMITS.variableValueBytes) {
      throw new PromptShortcutError('size_limit', 'Variable value exceeds the byte limit', [name]);
    }
  }
  return {
    id: parsed.data.id,
    snapshot,
    values: Object.fromEntries(
      snapshot.variables.map(({ name }) => [
        name,
        Object.hasOwn(parsed.data.values, name) ? parsed.data.values[name] : '',
      ])
    ),
  };
}

export function createShortcutInvocation(id: string, value: unknown): ShortcutInvocation {
  const snapshot = parsePromptShortcut(value);
  return {
    id,
    snapshot,
    values: Object.fromEntries(
      snapshot.variables.map((variable) => [variable.name, variable.defaultValue ?? ''])
    ),
  };
}

export function updateShortcutInvocation(
  invocation: ShortcutInvocation,
  value: unknown
): ShortcutInvocation {
  const next = createShortcutInvocation(invocation.id, value);
  if (
    next.snapshot.id === invocation.snapshot.id &&
    next.snapshot.workspaceId === invocation.snapshot.workspaceId
  ) {
    for (const variable of next.snapshot.variables) {
      if (Object.hasOwn(invocation.values, variable.name))
        next.values[variable.name] = invocation.values[variable.name]!;
    }
  }
  return next;
}

export type ExpandedShortcut = {
  text: string;
  mentions: PromptShortcutMention[];
  unresolved: { start: number; end: number; name: string; invocationId: string }[];
};

/** Generate text and offsets together. Injected values are never parsed as template syntax. */
export function expandShortcut(
  invocation: ShortcutInvocation,
  allowMissing = false,
  maxBytes = PROMPT_SHORTCUT_LIMITS.documentBytes
): ExpandedShortcut {
  invocation = parseShortcutInvocation(invocation);
  const snapshot = invocation.snapshot;
  const missing = snapshot.variables
    .filter((variable) => !invocation.values[variable.name]?.trim())
    .map((variable) => variable.name);
  if (missing.length && !allowMissing)
    throw new PromptShortcutError(
      'missing_variables',
      'Fill required variables before sending',
      missing
    );
  for (const variable of snapshot.variables) {
    if (
      shortcutByteLength(invocation.values[variable.name] ?? '') >
      PROMPT_SHORTCUT_LIMITS.variableValueBytes
    ) {
      throw new PromptShortcutError('size_limit', 'Variable value exceeds the byte limit', [
        variable.name,
      ]);
    }
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new PromptShortcutError('size_limit', 'Invalid expansion byte budget');
  const placeholders = parseShortcutPlaceholders(snapshot.prompt);
  const valueBytes = new Map(
    snapshot.variables.map(({ name }) => [name, shortcutByteLength(invocation.values[name])])
  );
  let expandedBytes = shortcutByteLength(snapshot.prompt);
  for (const placeholder of placeholders) {
    const replacementBytes =
      placeholder.escaped || missing.includes(placeholder.name)
        ? placeholder.name.length + 3
        : valueBytes.get(placeholder.name)!;
    // Placeholder grammar is ASCII, so its UTF-16 length equals its byte length.
    expandedBytes += replacementBytes - (placeholder.end - placeholder.start);
  }
  // Measure first: a small template may repeat an 8 KiB value thousands of
  // times. Reject before building an oversized string or allocating its UTF-8 copy.
  if (expandedBytes > maxBytes)
    throw new PromptShortcutError('size_limit', 'Expanded Shortcut exceeds the byte limit');
  const segments = [
    ...placeholders.map((placeholder) => ({
      ...placeholder,
      kind: 'placeholder' as const,
    })),
    ...snapshot.mentions.map((mention) => ({ ...mention, kind: 'mention' as const })),
  ].sort((a, b) => a.start - b.start);
  const result: ExpandedShortcut = { text: '', mentions: [], unresolved: [] };
  let cursor = 0;
  for (const segment of segments) {
    result.text += snapshot.prompt.slice(cursor, segment.start);
    const start = result.text.length;
    if (segment.kind === 'mention') {
      result.text += segment.label;
      result.mentions.push({
        start,
        end: result.text.length,
        label: segment.label,
        target: segment.target,
      });
    } else if (segment.escaped) {
      result.text += `!{${segment.name}}`;
    } else if (missing.includes(segment.name)) {
      result.text += `!{${segment.name}}`;
      result.unresolved.push({
        start,
        end: result.text.length,
        name: segment.name,
        invocationId: invocation.id,
      });
    } else {
      result.text += invocation.values[segment.name];
    }
    cursor = segment.end;
  }
  result.text += snapshot.prompt.slice(cursor);
  return result;
}

export function expandShortcutComposer(input: {
  text: string;
  mentions: readonly PromptShortcutMention[];
  invocations: readonly { start: number; end: number; invocation: ShortcutInvocation }[];
  maxBytes: number;
  allowMissing?: boolean;
}): ExpandedShortcut {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0)
    throw new PromptShortcutError('size_limit', 'Invalid message byte budget');
  const segments = [
    ...input.mentions.map((mention) => ({ ...mention, kind: 'mention' as const })),
    ...input.invocations.map((invocation) => ({ ...invocation, kind: 'shortcut' as const })),
  ].sort((a, b) => a.start - b.start);
  validateShortcutRanges(input.text, segments);
  const ids = input.invocations.map((item) => item.invocation.id);
  if (new Set(ids).size !== ids.length)
    throw new PromptShortcutError('invalid_ranges', 'Invocation ids must be unique');
  const result: ExpandedShortcut = { text: '', mentions: [], unresolved: [] };
  let usedBytes = 0;
  const append = (text: string) => {
    usedBytes += shortcutByteLength(text);
    if (usedBytes > input.maxBytes)
      throw new PromptShortcutError('size_limit', 'Expanded prompt exceeds the message byte limit');
    result.text += text;
  };
  let cursor = 0;
  for (const segment of segments) {
    append(input.text.slice(cursor, segment.start));
    const start = result.text.length;
    if (segment.kind === 'mention') {
      const label = input.text.slice(segment.start, segment.end);
      if (label !== segment.label)
        throw new PromptShortcutError('invalid_ranges', 'External mention label is stale');
      append(label);
      result.mentions.push({ start, end: result.text.length, label, target: segment.target });
    } else {
      if (input.text.slice(segment.start, segment.end) !== `/${segment.invocation.snapshot.slug}`) {
        throw new PromptShortcutError('invalid_ranges', 'Shortcut chip text is stale');
      }
      const expanded = expandShortcut(
        segment.invocation,
        input.allowMissing,
        input.maxBytes - usedBytes
      );
      append(expanded.text);
      result.mentions.push(
        ...expanded.mentions.map((mention) => ({
          ...mention,
          start: start + mention.start,
          end: start + mention.end,
        }))
      );
      result.unresolved.push(
        ...expanded.unresolved.map((item) => ({
          ...item,
          start: start + item.start,
          end: start + item.end,
        }))
      );
    }
    cursor = segment.end;
  }
  append(input.text.slice(cursor));
  return result;
}
