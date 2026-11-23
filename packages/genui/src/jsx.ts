/**
 * Parse the view part of a surface source into a UI tree. The view is a JSX
 * fragment: elements map to catalog components, `{expr}` holes become
 * `Expr` values evaluated per render, text stays literal.
 */
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import { GenuiError } from './errors.js';
import type { AstNode } from './evaluate.js';

export type UiValue = { kind: 'literal'; value: unknown } | { kind: 'expr'; node: AstNode };

export type UiNode = UiElement | UiText;

export interface UiElement {
  kind: 'element';
  tag: string;
  /** Ordered props; `name === '…'` is a `{...expr}` spread attribute. */
  props: { name: string; value: UiValue; spread?: boolean }[];
  children: UiNode[];
}

export interface UiText {
  kind: 'text';
  /** Literal chunks and `{expr}` holes, in order. */
  parts: (string | UiValue)[];
}

const JsxParser = Parser.extend(jsx());

export function parseView(view: string): UiNode {
  const source = `<>${view}</>`;
  let program: AstNode;
  try {
    program = JsxParser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as AstNode;
  } catch (error) {
    throw new GenuiError(
      'jsx',
      `invalid surface markup: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const statement = (program as unknown as { body: AstNode[] }).body[0];
  const fragment = statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
  if (!fragment || (fragment as AstNode).type !== 'JSXFragment') {
    throw new GenuiError('jsx', 'surface view must be a JSX fragment');
  }
  const node = convertFragment(fragment as AstNode);
  if (node.kind !== 'element') return node;
  return node;
}

function convertFragment(node: AstNode): UiNode {
  const children = convertChildren((node as { children?: AstNode[] }).children ?? []);
  return { kind: 'element', tag: '#fragment', props: [], children };
}

function convertChildren(children: AstNode[]): UiNode[] {
  const out: UiNode[] = [];
  for (const child of children) {
    const converted = convertNode(child);
    if (converted) out.push(converted);
  }
  return out;
}

function convertNode(node: AstNode): UiNode | undefined {
  switch (node.type) {
    case 'JSXText':
      return convertText(node.value as string);
    case 'JSXElement':
      return convertElement(node);
    case 'JSXFragment':
      return convertFragment(node);
    case 'JSXExpressionContainer': {
      const expr = node.expression as AstNode;
      if (expr.type === 'JSXEmptyExpression') return undefined;
      return { kind: 'text', parts: [{ kind: 'expr', node: expr }] };
    }
    case 'JSXSpreadChild': {
      const expr = node.expression as AstNode;
      return { kind: 'text', parts: [{ kind: 'expr', node: expr }] };
    }
    default:
      return undefined;
  }
}

/** JSX text rules: drop lines that are all whitespace, collapse the rest. */
function convertText(raw: string): UiText | undefined {
  const lines = raw.split('\n').map((line) => line.trim());
  const text = lines.filter((line) => line !== '').join(' ');
  if (text === '') return undefined;
  return { kind: 'text', parts: [text] };
}

function nameOf(node: AstNode): string {
  switch (node.type) {
    case 'JSXIdentifier':
      return node.name as string;
    case 'JSXMemberExpression':
      return `${nameOf(node.object as AstNode)}.${nameOf(node.property as AstNode)}`;
    case 'JSXNamespacedName':
      return `${nameOf(node.namespace as AstNode)}:${nameOf(node.name as AstNode)}`;
    default:
      return 'unknown';
  }
}

function convertElement(node: AstNode): UiElement {
  const opening = node.openingElement as AstNode;
  const props: UiElement['props'] = [];
  for (const attr of (opening.attributes as AstNode[]) ?? []) {
    if (attr.type === 'JSXSpreadAttribute') {
      props.push({
        name: '…',
        value: { kind: 'expr', node: attr.argument as AstNode },
        spread: true,
      });
      continue;
    }
    const name = nameOf(attr.name as AstNode);
    const value = attr.value as AstNode | null;
    if (value === null) {
      props.push({ name, value: { kind: 'literal', value: true } });
    } else if (value.type === 'Literal') {
      props.push({ name, value: { kind: 'literal', value: value.value } });
    } else if (value.type === 'JSXExpressionContainer') {
      const expr = value.expression as AstNode;
      if (expr.type === 'JSXEmptyExpression') {
        props.push({ name, value: { kind: 'literal', value: true } });
      } else {
        props.push({ name, value: { kind: 'expr', node: expr } });
      }
    } else {
      throw new GenuiError('jsx', `unsupported attribute value on '${name}'`, value.start);
    }
  }
  const children = convertChildren((node.children as AstNode[]) ?? []);
  return { kind: 'element', tag: nameOf(opening.name as AstNode), props, children };
}
