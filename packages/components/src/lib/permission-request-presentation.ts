import type { MessageContent } from '@lody/shared';
import { normalizeWorktreePath } from '@/lib/worktree-path';

type ToolCallContent = Extract<MessageContent, { type: 'tool_call' }>;
export type PermissionRequest = NonNullable<ToolCallContent['permissionRequest']>;
export type PermissionOption = PermissionRequest['options'][number];

/**
 * What a person needs to answer a permission request, read from what the agent
 * actually sent. The order of preference is the provider's own words first —
 * Claude and Codex send a heading ("Run command?", "Ready to code?") and a
 * reason in `_meta.permission` — and only then a heading derived from the tool
 * kind, because a derived one can only ever be generic.
 */

/** The generic question, by tool kind, for an agent that sent no heading. */
export type PermissionQuestionKind =
  | 'command'
  | 'edit'
  | 'delete'
  | 'move'
  | 'read'
  | 'search'
  | 'fetch'
  | 'plan'
  | 'tool';

export const resolvePermissionQuestionKind = (
  kind: ToolCallContent['kind'] | undefined
): PermissionQuestionKind => {
  switch (kind) {
    case 'execute':
    case 'bash':
      return 'command';
    case 'edit':
    case 'write':
      return 'edit';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'fetch':
      return 'fetch';
    case 'switch_mode':
      return 'plan';
    default:
      return 'tool';
  }
};

const readPermissionMeta = (
  meta: unknown
): { title: string | null; description: string | null; defaultToNo: boolean } => {
  const permission =
    meta && typeof meta === 'object' ? (meta as Record<string, unknown>).permission : undefined;
  if (!permission || typeof permission !== 'object') {
    return { title: null, description: null, defaultToNo: false };
  }
  const record = permission as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  return {
    title: text(record.title),
    description: text(record.description),
    defaultToNo: record.defaultToNo === true,
  };
};

/** The provider's own heading for the request, when it sent one. */
export const resolvePermissionHeading = (permission: PermissionRequest): string | null =>
  readPermissionMeta(permission._meta).title;

/** Why the agent is asking, when the provider said. */
export const resolvePermissionReason = (permission: PermissionRequest): string | null =>
  readPermissionMeta(permission._meta).description;

/**
 * What exactly would happen: the command line, the paths touched, or — when
 * the agent sent neither — its own title for the call. A plan decision has no
 * subject here: the plan is the message directly above it.
 */
export type PermissionSubject =
  | { type: 'command'; command: string; cwd: string | null }
  | { type: 'paths'; paths: string[] }
  | { type: 'text'; text: string };

export const resolvePermissionSubject = (toolCall: ToolCallContent): PermissionSubject | null => {
  const questionKind = resolvePermissionQuestionKind(toolCall.kind);
  if (questionKind === 'plan') return null;

  const commandBlock = toolCall.content?.find((block) => block.type === 'terminal_command');
  if (commandBlock && commandBlock.type === 'terminal_command') {
    const command = [commandBlock.command, ...(commandBlock.args ?? [])]
      .map((part) => normalizeWorktreePath(String(part ?? '')))
      .filter(Boolean)
      .join(' ');
    if (command) {
      return {
        type: 'command',
        command,
        cwd: commandBlock.cwd ? normalizeWorktreePath(commandBlock.cwd) : null,
      };
    }
  }

  const paths = (toolCall.locations ?? [])
    .map((location) => (location?.path ? normalizeWorktreePath(location.path) : ''))
    .filter((path, index, all) => path.length > 0 && all.indexOf(path) === index);
  if (paths.length > 0 && questionKind !== 'command') {
    return { type: 'paths', paths };
  }

  const title = toolCall.title?.trim();
  if (title) {
    return questionKind === 'command'
      ? { type: 'command', command: normalizeWorktreePath(title), cwd: null }
      : { type: 'text', text: normalizeWorktreePath(title) };
  }
  return null;
};

/**
 * How an option reads. ACP's four kinds plus Lody's `deny`; anything else a
 * custom agent invents is `other` and keeps its own words with no mark.
 */
export type PermissionOptionTone = 'allow' | 'allowAlways' | 'reject' | 'rejectAlways' | 'other';

export const resolvePermissionOptionTone = (option: PermissionOption): PermissionOptionTone => {
  // `deny` is Lody's own kind, stored alongside ACP's four.
  switch (option.kind as string | undefined) {
    case 'allow_once':
      return 'allow';
    case 'allow_always':
      return 'allowAlways';
    case 'reject_once':
    case 'deny':
      return 'reject';
    case 'reject_always':
      return 'rejectAlways';
    default:
      return 'other';
  }
};

/** An option's explanation: ACP's own field, or where Codex puts it. */
export const resolvePermissionOptionDescription = (option: PermissionOption): string | null => {
  // Stored history accepts ACP's optional `description`; the SDK type omits it.
  const description = (option as { description?: unknown }).description;
  if (typeof description === 'string' && description.trim()) {
    return description.trim();
  }
  return readPermissionMeta(option._meta).description;
};

/**
 * The answer the request suggests. A provider that marks the request
 * `defaultToNo` (Claude, for a risky call) suggests the first refusal;
 * otherwise the first one-time allow, never an "always" — widening what the
 * agent may do from now on is never the suggestion.
 */
export const resolveSuggestedOptionId = (permission: PermissionRequest): string | null => {
  const options = permission.options;
  if (readPermissionMeta(permission._meta).defaultToNo) {
    const refusal = options.find((option) => resolvePermissionOptionTone(option) === 'reject');
    if (refusal) return refusal.optionId;
  }
  const once = options.find((option) => resolvePermissionOptionTone(option) === 'allow');
  return once?.optionId ?? options[0]?.optionId ?? null;
};

/**
 * What Escape answers: a one-time refusal, and only that. An "always" refusal
 * (block this host from now on) is a decision a key press must not make, so
 * a request that offers only that has no Escape answer.
 */
export const resolveDismissOptionId = (options: readonly PermissionOption[]): string | null =>
  options.find((option) => resolvePermissionOptionTone(option) === 'reject')?.optionId ?? null;
