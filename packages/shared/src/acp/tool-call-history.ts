import type { MessageContent } from '../ai';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ToolCallContent = NonNullable<ToolCallMessage['content']>;
type ToolCallKind = ToolCallMessage['kind'] | null | undefined;
type ToolCallLocations = NonNullable<ToolCallMessage['locations']>;

/**
 * Session history is persisted in a Loro CRDT document.
 *
 * Tool calls are the biggest contributor to document size because providers often include:
 * - full file contents on reads
 * - full old/new text on edits
 * - snapshot-style terminal output repeated on every incremental update
 *
 * This module centralizes the "what is safe to store" policy so we can:
 * - keep history useful for follow-along (titles, status, commands, paths)
 * - avoid persisting large / redundant payloads across trust boundaries
 */

export const deriveLocationsFromToolCallContent = (
  content: unknown
): ToolCallLocations | undefined => {
  if (!Array.isArray(content)) return undefined;
  const paths = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (!('type' in block)) continue;
    if ((block as { type?: unknown }).type !== 'diff') continue;
    const maybePath = (block as { path?: unknown }).path;
    if (typeof maybePath !== 'string' || maybePath.length === 0) continue;
    paths.add(maybePath);
  }
  if (paths.size === 0) return undefined;
  return Array.from(paths).map((path) => ({ path }));
};

/**
 * Best-effort path extraction from raw tool input when the upstream doesn't send `locations`.
 *
 * This is intentionally heuristic: rawInput is unstructured by ACP spec and differs per agent.
 * We only try a small set of common keys to keep behavior predictable.
 */
export const deriveLocationsFromRawInput = (rawInput: unknown): ToolCallLocations | undefined => {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const record = rawInput as Record<string, unknown>;

  const candidates: unknown[] = [
    record.path,
    record.file_path,
    record.filePath,
    record.absolute_file_path,
  ];

  const args = record.args;
  if (args && typeof args === 'object') {
    const argsRecord = args as Record<string, unknown>;
    candidates.push(
      argsRecord.path,
      argsRecord.file_path,
      argsRecord.filePath,
      argsRecord.absolute_file_path
    );
  }

  const unique = new Set<string>();
  for (const value of candidates) {
    if (typeof value !== 'string' || value.length === 0) continue;
    unique.add(value);
  }
  if (unique.size === 0) return undefined;
  return Array.from(unique).map((path) => ({ path }));
};

/** An image block, or a blob resource identified as an image by MIME type or data URI. */
const isToolImagePayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const { type, resource } = value as { type?: unknown; resource?: unknown };
  if (type === 'image') return true;
  if (type !== 'resource' || !resource || typeof resource !== 'object') return false;
  if (!('blob' in resource)) return false;
  const { mimeType, uri } = resource as { mimeType?: unknown; uri?: unknown };
  return (
    (typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith('image/')) ||
    (typeof uri === 'string' && uri.trim().toLowerCase().startsWith('data:image/'))
  );
};

/** Tool images are execution output, not durable conversation attachments. */
export const stripToolCallPayloadsForHistory = (content: ToolCallContent): ToolCallContent =>
  content
    .filter((block) => block.type !== 'content' || !isToolImagePayload(block.content))
    .map((block) => {
      if (block.type !== 'content') return block;
      const value = block.content;
      // The detail view downloads resources through their URI; it never reads
      // non-image blob bytes. Keep the resource and link instead of dropping it.
      if (value.type === 'resource') {
        const resource = value.resource;
        const clearBlob =
          'blob' in resource && typeof resource.blob === 'string' && resource.blob !== '';
        const clearUri = typeof resource.uri === 'string' && /^\s*data:/i.test(resource.uri);
        if (!clearBlob && !clearUri) return block;
        return {
          ...block,
          content: {
            ...value,
            resource: {
              ...resource,
              ...(clearBlob ? { blob: '' } : {}),
              ...(clearUri ? { uri: '' } : {}),
            },
          },
        };
      }
      // data: links already render only their label under the UI's URL policy.
      if (value.type === 'resource_link' && /^\s*data:/i.test(value.uri))
        return { ...block, content: { ...value, uri: '' } };
      // Do not parse, truncate or "repair" other blocks here. New malformed
      // values must reach writer validation; unchanged legacy content must survive.
      return block;
    });

/**
 * Removes large data payloads from tool call blocks before persisting to session history.
 *
 * We still keep:
 * - the command block (what was executed)
 * - terminal output (for non-read tools), later truncated to a bounded size elsewhere
 * - metadata such as status/title/locations
 */
export const stripToolCallContentForHistory = (
  kind: ToolCallKind,
  content: ToolCallContent
): ToolCallContent => {
  if (kind === 'read') {
    // Reading a file often returns the full file text. We keep only the command and the path.
    return content.filter((block) => block.type === 'terminal_command');
  }
  if (kind === 'edit') {
    // Edits often include full old/new text in `diff` blocks; don't persist that.
    // Some agents also emit a human-readable success `content` block; keep history lean by dropping it.
    return content.filter((block) => block.type !== 'diff' && block.type !== 'content');
  }
  return stripToolCallPayloadsForHistory(content);
};
