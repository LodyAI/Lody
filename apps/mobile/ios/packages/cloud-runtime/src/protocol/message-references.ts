import type { MentionItem } from '../models/mentions.ts';
import { mentionPrompt } from '../runtime/mention-expansion.ts';

/** Web-compatible UTF-16 ranges in the original wire text. */
export type MessageReference = {
  start: number;
  end: number;
  kind: string;
  label: string;
  target?: string;
  mark?: string;
};
const kinds = new Set([
  'file',
  'dir',
  'skill',
  'session',
  'command',
  'prompt_shortcut',
  'agent_role',
  'issue',
  'pr',
  'mention',
]);
const code = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+/g;
function protectedRanges(text: string) {
  return [...text.matchAll(code)].map((m) => [
    m.index!,
    m.index! + m[0].length,
  ]);
}
function valid(text: string, input: unknown): MessageReference[] {
  if (!Array.isArray(input)) return [];
  const protectedText = protectedRanges(text);
  let end = 0;
  return input
    .filter((s): s is MessageReference => s && typeof s === 'object')
    .sort((a, b) => a.start - b.start)
    .filter((s) => {
      if (
        !Number.isInteger(s.start) ||
        !Number.isInteger(s.end) ||
        s.start < end ||
        s.start < 0 ||
        s.end <= s.start ||
        s.end > text.length ||
        !kinds.has(s.kind) ||
        typeof s.label !== 'string' ||
        !s.label.trim() ||
        s.label.length > 2048 ||
        /[\r\n]/.test(s.label)
      )
        return false;
      // Never split a surrogate pair or reinterpret code examples.
      if (
        [s.start, s.end].some(
          (i) =>
            i > 0 &&
            /[\uDC00-\uDFFF]/.test(text[i] ?? '') &&
            /[\uD800-\uDBFF]/.test(text[i - 1]),
        )
      )
        return false;
      if (protectedText.some(([a, b]) => s.start < b && s.end > a))
        return false;
      end = s.end;
      return true;
    });
}
export function referenceSpans(
  text: string,
  items: readonly MentionItem[],
): MessageReference[] {
  const spans: MessageReference[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const token = mentionPrompt(item);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    let start = text.indexOf(token);
    while (start >= 0) {
      spans.push({
        start,
        end: start + token.length,
        kind:
          item.kind === 'role'
            ? 'agent_role'
            : item.kind === 'directory'
              ? 'dir'
              : item.kind === 'cmd'
                ? 'command'
                : item.kind,
        label: item.name,
        target: item.path,
        ...(item.emoji ? { mark: item.emoji } : {}),
      });
      start = text.indexOf(token, start + token.length);
    }
  }
  return valid(text, spans);
}
function label(s: MessageReference): string {
  if (s.kind === 'agent_role')
    return `${typeof s.mark === 'string' && s.mark.length <= 32 ? s.mark : '🪼'} ${s.label}`;
  const sigil =
    s.kind === 'skill'
      ? '$'
      : s.kind === 'issue' || s.kind === 'pr'
        ? '#'
        : s.kind === 'command' || s.kind === 'prompt_shortcut'
          ? '/'
          : '@';
  return s.label.startsWith(sigil) ? s.label : sigil + s.label;
}
export function presentMessageText(
  text: string,
  input?: unknown,
): { text: string; references: MessageReference[] } {
  const spans = valid(text, input);
  // Older native clients did not persist display spans. Only recognize the exact
  // generated grammar; ordinary prose and code must remain untouched.
  if (input === undefined) {
    const legacy =
      /use lody mcp to query session\[id: [^\]\n]+\] history|use lody mcp to create a session with agent role\[id: [^\]\n]+?, name: ([^\]\n]+)\]|@session:[\w-]+|@role:[\w-]+(?:@[\w-]+)?/g;
    for (const m of text.matchAll(legacy))
      spans.push({
        start: m.index!,
        end: m.index! + m[0].length,
        kind: m[1] || m[0].startsWith('@role:') ? 'agent_role' : 'session',
        label: m[1] ?? (m[0].startsWith('@role:') ? 'Role' : 'Session'),
      });
  }
  const readable =
    /(?<!\S)use \/([^\s]+) \[Skill Path\]\(((?:\\.|[^\\)])+)\)|(?<!\S)@(?:"((?:\\.|[^"\\])*)"|([^\s@"`]+))|(?<!\S)(\$[^\s$]+|#[1-9][0-9]*)(?=$|\s|[.,;!?])/g;
  for (const m of text.matchAll(readable)) {
    const start = m.index!,
      end = start + m[0].length;
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    if (m[1])
      spans.push({
        start,
        end,
        kind: 'skill',
        label: m[1],
        target: m[2].replace(/\\([\\)])/g, '$1'),
      });
    else if (m[3] || m[4]) {
      const path = (m[3] ?? m[4]).replace(/[.,;!?]+$/, '');
      if (path.includes(':') || path.startsWith('//')) continue;
      spans.push({
        start,
        end: end - (m[4] ? m[4].length - path.length : 0),
        kind: path.endsWith('/') ? 'dir' : 'file',
        label: path,
        target: path,
      });
    } else if (m[5])
      spans.push({
        start,
        end,
        kind: m[5].startsWith('$') ? 'skill' : 'issue',
        label: m[5],
      });
  }
  let cursor = 0,
    result = '';
  const references: MessageReference[] = [];
  for (const span of valid(text, spans)) {
    result += text.slice(cursor, span.start);
    const start = result.length;
    result += label(span);
    references.push({ ...span, start, end: result.length });
    cursor = span.end;
  }
  return { text: result + text.slice(cursor), references };
}
