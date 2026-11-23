import type { MessageContent } from '../ai';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ToolCallContent = NonNullable<ToolCallMessage['content']>;
type ToolCallKind = ToolCallMessage['kind'] | null | undefined;
type ToolCallLocations = NonNullable<ToolCallMessage['locations']>;

/**
 * Durable UTF-8 byte ceiling for individual text/diff/plan payloads persisted in
 * session history. Chosen generously above normal readable tool outputs (e.g.
 * ~130 KB diffs/plans) while preventing multi-megabyte tool dumps from bloating
 * the session CRDT.
 */
export const MAX_STORED_TOOL_TEXT_BYTES = 256 * 1024;

/**
 * Audio payloads are binary media data, not readable text. Small inline test
 * fixtures pass untouched; real multi-KB/MB base64 blobs are cleared on write.
 */
export const MAX_STORED_AUDIO_DATA_BYTES = 16 * 1024;

const INLINE_BASE64_DATA_URI_PATTERN =
  /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.=+-]+)*;base64,[A-Za-z0-9+/=\r\n]{1024,}/gi;

const utf8Head = (value: string, maxBytes: number): { end: number; bytes: number } => {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const unit = value.charCodeAt(end);
    const isPair =
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      end + 1 < value.length &&
      (value.charCodeAt(end + 1) & 0xfc00) === 0xdc00;
    const width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : isPair ? 4 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += isPair ? 2 : 1;
  }
  return { end, bytes };
};

const utf8Tail = (value: string, maxBytes: number): { start: number; bytes: number } => {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    const prev = value.charCodeAt(start - 1);
    const beforePrev = start >= 2 ? value.charCodeAt(start - 2) : 0;
    const isPair = prev >= 0xdc00 && prev <= 0xdfff && beforePrev >= 0xd800 && beforePrev <= 0xdbff;
    const width = isPair ? 4 : prev < 0x80 ? 1 : prev < 0x800 ? 2 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    start -= isPair ? 2 : 1;
  }
  return { start, bytes };
};

const utf8ByteLength = (value: string): number => utf8Head(value, Number.MAX_SAFE_INTEGER).bytes;

const exceedsUtf8Bytes = (value: string, maxBytes: number): boolean =>
  utf8Head(value, maxBytes).end < value.length;

/** Replace large embedded base64 data URIs inside text payloads without touching small examples. */
export const scrubInlineBase64DataUris = (value: string): string => {
  if (!value.includes('data:') || !value.includes(';base64,')) return value;
  return value.replace(INLINE_BASE64_DATA_URI_PATTERN, '[omitted base64 data]');
};

/**
 * Scrub large inline base64 data URIs and keep head+tail UTF-8 slices within
 * `maxBytes` without splitting Unicode surrogate pairs or scanning huge strings twice.
 */
export const truncateToolTextForHistory = (
  value: string,
  maxBytes: number = MAX_STORED_TOOL_TEXT_BYTES
): string => {
  const scrubbed = scrubInlineBase64DataUris(value);
  if (!exceedsUtf8Bytes(scrubbed, maxBytes)) return scrubbed;

  const formatMarker = (omittedChars: number) => `\n…[truncated ${omittedChars} chars]…\n`;
  const worstMarkerBytes = utf8ByteLength(formatMarker(scrubbed.length));
  const remainingBudget = maxBytes - worstMarkerBytes;
  if (remainingBudget <= 0) {
    return scrubbed.slice(0, utf8Head(scrubbed, maxBytes).end);
  }

  const headBudget = Math.floor(remainingBudget / 2);
  const tailBudget = remainingBudget - headBudget;
  const head = utf8Head(scrubbed, headBudget);
  const tail = utf8Tail(scrubbed, tailBudget);
  if (head.end >= tail.start) return scrubbed;
  const omittedChars = tail.start - head.end;
  return `${scrubbed.slice(0, head.end)}${formatMarker(omittedChars)}${scrubbed.slice(tail.start)}`;
};

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
      if (block.type === 'diff') {
        const nextOldText =
          typeof block.oldText === 'string'
            ? truncateToolTextForHistory(block.oldText)
            : block.oldText;
        const nextNewText =
          typeof block.newText === 'string'
            ? truncateToolTextForHistory(block.newText)
            : block.newText;
        if (nextOldText === block.oldText && nextNewText === block.newText) return block;
        return { ...block, oldText: nextOldText, newText: nextNewText };
      }
      if (block.type !== 'content') return block;
      const value = block.content;
      if (value.type === 'text' && typeof value.text === 'string') {
        const nextText = truncateToolTextForHistory(value.text);
        if (nextText === value.text) return block;
        return { ...block, content: { ...value, text: nextText } };
      }
      if (
        value.type === 'audio' &&
        typeof value.data === 'string' &&
        exceedsUtf8Bytes(value.data, MAX_STORED_AUDIO_DATA_BYTES)
      ) {
        return { ...block, content: { ...value, data: '' } };
      }
      // The detail view downloads resources through their URI; it never reads
      // non-image blob bytes. Keep the resource and link instead of dropping it.
      if (value.type === 'resource') {
        const resource = value.resource;
        const clearBlob =
          'blob' in resource && typeof resource.blob === 'string' && resource.blob !== '';
        const clearUri = typeof resource.uri === 'string' && /^\s*data:/i.test(resource.uri);
        const hasText = 'text' in resource && typeof resource.text === 'string';
        const nextText = hasText ? truncateToolTextForHistory(resource.text) : undefined;
        const truncateText = hasText && nextText !== resource.text;
        if (!clearBlob && !clearUri && !truncateText) return block;
        return {
          ...block,
          content: {
            ...value,
            resource: {
              ...resource,
              ...(clearBlob ? { blob: '' } : {}),
              ...(clearUri ? { uri: '' } : {}),
              ...(truncateText ? { text: nextText } : {}),
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
