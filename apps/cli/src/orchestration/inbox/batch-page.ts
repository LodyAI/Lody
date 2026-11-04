import type { InboxMember } from './model';

export const INBOX_READ_BYTES = 128 * 1024;
/** Large individual results progress through bounded JSON fragments, too. */
export function batchPage(members: readonly InboxMember[], limit: number, offset = 0) {
  const items: Array<
    | InboxMember
    | {
        sequence: number;
        operationId: string;
        encoding: 'member-json';
        offset: number;
        totalChars: number;
        jsonChunk: string;
      }
  > = [];
  let bytes = 2048;
  let next: string | undefined;
  for (const member of members.slice(0, limit)) {
    const json = JSON.stringify(member);
    const size = Buffer.byteLength(json);
    if (!offset && bytes + size < INBOX_READ_BYTES) {
      items.push(member);
      bytes += size;
      next = `${member.sequence}:0`;
      continue;
    }
    if (items.length) break;
    if (offset >= json.length) throw new Error('Invalid batch content cursor');
    let count = Math.min(json.length - offset, Math.floor((INBOX_READ_BYTES - bytes) / 8));
    // Do not split a UTF-16 surrogate pair between pages.
    if (offset + count < json.length && /[\uD800-\uDBFF]/u.test(json.charAt(offset + count - 1)))
      count--;
    items.push({
      sequence: member.sequence,
      operationId: member.operationId,
      encoding: 'member-json',
      offset,
      totalChars: json.length,
      jsonChunk: json.slice(offset, offset + count),
    });
    next = `${member.sequence}:${offset + count < json.length ? offset + count : 0}`;
    break;
  }
  const fragmented = items[items.length - 1];
  const hasMore =
    members.length > items.length ||
    (!!fragmented &&
      'encoding' in fragmented &&
      fragmented.offset + fragmented.jsonChunk.length < fragmented.totalChars);
  return { items, hasMore, next: hasMore ? next : undefined };
}
