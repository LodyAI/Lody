/**
 * Tolerant parse of a view that may still be streaming. Where `parseView`
 * requires the whole fragment to be valid, `parseViewPartial` commits what is
 * complete: an element mounts when its open tag closes, children stream into
 * open elements, and the unparseable tail is returned as `pending` for the
 * host to show or hide. Malformed-but-complete constructs hold the tail too;
 * the committed compile reports them as diagnostics.
 */
import { Parser } from 'acorn';
import { scanBalanced } from './directives.js';
import type { GenuiDiagnostic } from './errors.js';
import type { AstNode } from './evaluate.js';
import { convertText, type UiElement, type UiNode } from './jsx.js';

export interface PartialView {
  /** A `#fragment` element whose children are the committed nodes. */
  readonly node: UiElement;
  /** Trailing source that has not committed yet. */
  readonly pending: string;
  readonly diagnostics: GenuiDiagnostic[];
}

const TAG_NAME = /[a-zA-Z][\w.:-]*/y;
const ATTR_NAME = /[a-zA-Z_][\w-]*/y;

export function parseViewPartial(view: string): PartialView {
  const root: UiElement = { kind: 'element', tag: '#fragment', props: [], children: [] };
  const stack: UiElement[] = [];
  const diagnostics: GenuiDiagnostic[] = [];
  let pending = '';
  let i = 0;
  let textStart = 0;

  const children = (): UiNode[] =>
    stack.length ? stack[stack.length - 1].children : root.children;
  const flushText = (end: number) => {
    const text = convertText(view.slice(textStart, end));
    if (text) children().push(text);
  };

  while (i < view.length) {
    const char = view[i];
    if (char === '<') {
      const tag = scanTag(view, i);
      if (tag === null) {
        i += 1;
        continue;
      }
      if (tag.kind === 'pending') {
        flushText(i);
        pending = view.slice(i);
        break;
      }
      flushText(i);
      if (tag.kind === 'close') {
        closeElement(stack, tag.name);
      } else {
        children().push(tag.element);
        if (tag.kind === 'open') stack.push(tag.element);
      }
      i = tag.end;
      textStart = i;
      continue;
    }
    if (char === '{') {
      const end = scanBalanced(view, i);
      if (end === -1) {
        flushText(i);
        pending = view.slice(i);
        break;
      }
      flushText(i);
      const part = parseExprHole(view.slice(i + 1, end - 1), i, diagnostics);
      if (part) children().push({ kind: 'text', parts: [part] });
      i = end;
      textStart = i;
      continue;
    }
    i += 1;
  }
  if (pending === '') flushText(view.length);
  return { node: root, pending, diagnostics };
}

function closeElement(stack: UiElement[], name: string) {
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    if (stack[depth].tag === name) {
      stack.length = depth;
      return;
    }
  }
}

type TagScan =
  | { kind: 'pending' }
  | { kind: 'open'; element: UiElement; end: number }
  | { kind: 'self'; element: UiElement; end: number }
  | { kind: 'close'; name: string; end: number }
  | null;

function scanTag(view: string, start: number): TagScan {
  let i = start + 1;
  if (i >= view.length) return { kind: 'pending' };
  if (view[i] === '/') {
    i += 1;
    if (view[i] === '>') return { kind: 'close', name: '#fragment', end: i + 1 };
    const name = read(TAG_NAME, view, i);
    if (name === null) return null;
    i += name.length;
    i = skipSpace(view, i);
    if (i >= view.length) return { kind: 'pending' };
    if (view[i] !== '>') return null;
    return { kind: 'close', name, end: i + 1 };
  }
  if (view[i] === '>') {
    return {
      kind: 'open',
      element: { kind: 'element', tag: '#fragment', props: [], children: [] },
      end: i + 1,
    };
  }
  const name = read(TAG_NAME, view, i);
  if (name === null) return null;
  i += name.length;
  const props: UiElement['props'] = [];
  for (;;) {
    i = skipSpace(view, i);
    if (i >= view.length) return { kind: 'pending' };
    const char = view[i];
    if (char === '>') {
      return {
        kind: 'open',
        element: { kind: 'element', tag: name, props, children: [] },
        end: i + 1,
      };
    }
    if (char === '/') {
      if (view[i + 1] === '>') {
        return {
          kind: 'self',
          element: { kind: 'element', tag: name, props, children: [] },
          end: i + 2,
        };
      }
      return { kind: 'pending' };
    }
    if (char === '{') {
      const end = scanBalanced(view, i);
      if (end === -1) return { kind: 'pending' };
      const inner = view.slice(i + 1, end - 1).trim();
      if (!inner.startsWith('...')) return { kind: 'pending' };
      const node = parseExpression(inner.slice(3));
      if (!node) return { kind: 'pending' };
      props.push({ name: '…', value: { kind: 'expr', node }, spread: true });
      i = end;
      continue;
    }
    const attr = read(ATTR_NAME, view, i);
    if (attr === null) return { kind: 'pending' };
    i += attr.length;
    i = skipSpace(view, i);
    if (view[i] !== '=') {
      props.push({ name: attr, value: { kind: 'literal', value: true } });
      continue;
    }
    i = skipSpace(view, i + 1);
    if (i >= view.length) return { kind: 'pending' };
    const value = view[i];
    if (value === '"' || value === "'") {
      const close = view.indexOf(value, i + 1);
      if (close === -1) return { kind: 'pending' };
      props.push({ name: attr, value: { kind: 'literal', value: view.slice(i + 1, close) } });
      i = close + 1;
      continue;
    }
    if (value === '{') {
      const end = scanBalanced(view, i);
      if (end === -1) return { kind: 'pending' };
      const node = parseExpression(view.slice(i + 1, end - 1));
      if (!node) return { kind: 'pending' };
      props.push({ name: attr, value: { kind: 'expr', node } });
      i = end;
      continue;
    }
    return { kind: 'pending' };
  }
}

function read(pattern: RegExp, view: string, start: number): string | null {
  pattern.lastIndex = start;
  const match = pattern.exec(view);
  return match && match.index === start ? match[0] : null;
}

function skipSpace(view: string, i: number): number {
  while (i < view.length && /\s/.test(view[i])) i += 1;
  return i;
}

const EMPTY_HOLE = /^(\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*$/;

function parseExpression(source: string): AstNode | null {
  const trimmed = source.trim();
  if (trimmed === '') return null;
  try {
    const program = Parser.parse(trimmed, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as { body: AstNode[] };
    if (program.body.length !== 1) return null;
    const statement = program.body[0];
    return statement.type === 'ExpressionStatement' ? (statement.expression as AstNode) : null;
  } catch {
    return null;
  }
}

function parseExprHole(
  inner: string,
  offset: number,
  diagnostics: GenuiDiagnostic[]
): { kind: 'expr'; node: AstNode } | undefined {
  const source = inner.trimStart().startsWith('...') ? inner.trimStart().slice(3) : inner;
  if (EMPTY_HOLE.test(source)) return undefined;
  const node = parseExpression(source);
  if (node) return { kind: 'expr', node };
  diagnostics.push({ phase: 'jsx', message: 'invalid expression', offset });
  return undefined;
}
