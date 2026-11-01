import { isRecognizedFilePath } from '@/components/icons/file-icons/mappings';
import { parseMarkdownAgentFileHref } from './markdown-agent-file-link';

// Auto-detect bare file paths in agent Markdown (text nodes + inline code) and
// turn them into the same clickable file chips that explicit `[text](path)`
// links already render. Unlike URLs, bare paths have no unambiguous marker
// (`https://`), so detection is intentionally conservative to avoid turning
// prose like `and/or`, `Math.max`, or `Node.js` into broken file links:
//
//   - prose (plain text): require a path separator with a real extension
//     (`a/b/foo.ts`) OR an explicit line suffix (`foo.ts:32`, `foo.ts:L32`).
//   - inline code: the ENTIRE backtick content must be a single recognized
//     file path; partial spans inside commands/snippets are left as code.
//
// These are candidates only. Conversation rendering confirms relative paths
// against the owning file index; absolute paths can open directly.

export type FilePathTextSegment = { type: 'text'; value: string } | { type: 'path'; value: string };

// One greedy run of path-ish characters, plus an optional GitHub/VSCode/colon
// line suffix. The char class excludes whitespace and CJK, so a candidate
// naturally stops at word/sentence boundaries (incl. inside CJK prose).
const PATH_BODY = String.raw`(?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.{1,2}[\\/])?[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*`;
const LINE_SUFFIX = String.raw`(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:L?\d+(?:C\d+)?(?::\d+)?)`;
const CANDIDATE_PATTERN = new RegExp(`${PATH_BODY}(?:${LINE_SUFFIX})?`, 'g');

// Paths essentially never end in punctuation, so we can strip a trailing run
// (sentence/quote/bracket chars, incl. full-width CJK) without balancing.
const TRAILING_PUNCT_PATTERN = /[.,;:!?'")\]}>，。！？；：、）】」』》“”‘’]+$/u;

// Bare-host TLDs we treat as "this is probably an unscheme'd URL, not a file".
const URL_LIKE_TLDS = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'app',
  'co',
  'ai',
  'gov',
  'edu',
  'info',
]);

const stripTrailingPunctuation = (value: string): string => {
  const match = value.match(TRAILING_PUNCT_PATTERN);
  return match ? value.slice(0, value.length - match[0].length) : value;
};

// `example.com/page.html` looks exactly like `dir/file.html`; skip when the
// first segment is a dotted host ending in a known TLD.
const looksLikeBareDomain = (base: string): boolean => {
  const firstSegment = base.split(/[\\/]/, 1)[0] ?? '';
  const labels = firstSegment.split('.');
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1]?.toLowerCase() ?? '';
  return URL_LIKE_TLDS.has(tld);
};

const qualifiesAsFilePath = (raw: string, context: 'prose' | 'code'): boolean => {
  const parsed = parseMarkdownAgentFileHref(raw);
  if (!parsed) {
    return false;
  }

  const base = parsed.filePath;
  const hasLineSuffix = parsed.startLine != null;
  const hasSlash = base.includes('/');
  const lastSegment = base.slice(base.lastIndexOf('/') + 1);
  const dotIndex = lastSegment.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < lastSegment.length - 1;
  const recognized = isRecognizedFilePath(lastSegment);

  if (hasSlash) {
    // A separator + extension is a strong path signal on its own.
    return hasExtension && !looksLikeBareDomain(base);
  }

  if (context === 'prose') {
    // No separator in prose: only a line suffix on a recognized file is safe
    // enough (e.g. `app.ts:32`); a lone `app.ts` is too ambiguous in prose.
    return hasLineSuffix && hasExtension && recognized;
  }

  // Inline code, no separator: the author marked it as a token, so a
  // recognized file name/extension is sufficient (`tsconfig.json`, `foo.ts`).
  return hasExtension && recognized;
};

// Split a plain-text node into text / file-path segments. Rejected candidates
// stay as text, so the result round-trips the original string.
export const splitTextIntoFilePathSegments = (value: string): FilePathTextSegment[] => {
  const segments: FilePathTextSegment[] = [];
  CANDIDATE_PATTERN.lastIndex = 0;

  let cursor = 0;
  let match = CANDIDATE_PATTERN.exec(value);
  while (match) {
    const rawMatch = match[0];
    const matchStart = match.index;
    const prevChar = matchStart > 0 ? value[matchStart - 1] : '';

    // Skip the host/path part of an email like `user@example.com/x`.
    const isEmailTail = prevChar === '@';
    // Cheap pre-filter: a real path has a separator, a line/anchor suffix, or
    // a `.ext`. Lone words fall through and stay as text.
    const couldBePath =
      /[\\/]/.test(rawMatch) || /[:#]/.test(rawMatch) || /\.[A-Za-z0-9]/.test(rawMatch);

    if (!isEmailTail && couldBePath) {
      const path = stripTrailingPunctuation(rawMatch);
      if (path && qualifiesAsFilePath(path, 'prose')) {
        if (matchStart > cursor) {
          segments.push({ type: 'text', value: value.slice(cursor, matchStart) });
        }
        segments.push({ type: 'path', value: path });
        // Leave any stripped trailing punctuation for the next text flush.
        cursor = matchStart + path.length;
      }
    }

    match = CANDIDATE_PATTERN.exec(value);
  }

  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }

  return segments;
};

// For inline code: returns the path when the ENTIRE content is one file path,
// else null (leave it rendered as code).
export const matchWholeFilePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  return qualifiesAsFilePath(trimmed, 'code') ? trimmed : null;
};
