/**
 * Extract `{@name code}` directives from a surface source. Directives are
 * brace-delimited blocks that may appear anywhere outside a JSX tag; the rest
 * of the source is the view, parsed as a JSX fragment.
 *
 * The scanner balances braces while skipping strings, template literals,
 * escapes and comments, so directive bodies may contain arbitrary JavaScript.
 */
import { GenuiError } from './errors.js';

export interface SurfaceDirective {
  readonly name: string;
  /** The code between `{@name` and the matching `}`. */
  readonly code: string;
  readonly offset: number;
}

export interface SplitSource {
  readonly view: string;
  readonly directives: SurfaceDirective[];
}

const DIRECTIVE_HEAD = /\{@([a-zA-Z][a-zA-Z0-9_-]*)\s*/y;

export function splitDirectives(source: string): SplitSource {
  const { view, directives, pending } = split(source);
  if (pending !== null) {
    DIRECTIVE_HEAD.lastIndex = 0;
    const name = DIRECTIVE_HEAD.exec(pending)?.[1] ?? '';
    throw new GenuiError(
      'directives',
      `unclosed '{@${name}' directive`,
      source.length - pending.length
    );
  }
  return { view, directives };
}

/**
 * Streaming variant: an unclosed `{@name` directive is held back as `pending`
 * instead of failing, so a fence still being written parses what it has.
 */
export function splitDirectivesPartial(source: string): SplitSource & { pending: string } {
  const { view, directives, pending } = split(source);
  return { view, directives, pending: pending ?? '' };
}

function split(source: string): SplitSource & { pending: string | null } {
  const directives: SurfaceDirective[] = [];
  let view = '';
  let cursor = 0;

  while (cursor < source.length) {
    const brace = source.indexOf('{', cursor);
    if (brace === -1) {
      view += source.slice(cursor);
      break;
    }
    DIRECTIVE_HEAD.lastIndex = brace;
    const match = DIRECTIVE_HEAD.exec(source);
    if (!match) {
      view += source.slice(cursor, brace + 1);
      cursor = brace + 1;
      continue;
    }
    const name = match[1];
    const bodyStart = DIRECTIVE_HEAD.lastIndex;
    const end = scanBalanced(source, brace);
    if (end === -1) {
      view += source.slice(cursor, brace);
      return { view, directives, pending: source.slice(brace) };
    }
    view += source.slice(cursor, brace);
    directives.push({ name, code: source.slice(bodyStart, end - 1).trim(), offset: brace });
    cursor = end;
  }

  return { view, directives, pending: null };
}

/** Return the index just past the `}` that closes the `{` at `open`, or -1. */
export function scanBalanced(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const char = source[i];
    if (char === "'" || char === '"') {
      i = skipQuoted(source, i, char);
      if (i === -1) return -1;
      continue;
    }
    if (char === '`') {
      i = skipTemplate(source, i);
      if (i === -1) return -1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return -1;
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') return i + 1;
    if (source[i] === '$' && source[i + 1] === '{') {
      const end = scanBalanced(source, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    i += 1;
  }
  return -1;
}
