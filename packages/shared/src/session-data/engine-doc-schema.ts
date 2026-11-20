import type { DocNodeKind, DocPatternSeg, DocSchema } from '@loro-dev/loro-repo-client';

// # Engine document schema from a Mirror schema
//
// A remote writer applies JSON patches in the engine instead of Loro ops in a
// local replica. The containers the engine creates must be the ones the Mirror
// and the HistoryWriter create, so the persisted `DocSchema` is derived from the
// same loro-mirror schema and its inference: objects become maps and arrays
// lists, strings stay primitive, and only the declared streaming texts and
// movable lists differ (`Any` storage hints included).

type MirrorNode = {
  readonly type?: string;
  readonly definition?: Readonly<Record<string, MirrorNode>>;
  readonly itemSchema?: MirrorNode;
  readonly catchallType?: MirrorNode;
  readonly options?: object;
};
const storageSchemaOf = (node: MirrorNode): MirrorNode | undefined =>
  (node.options as { storageSchema?: MirrorNode } | undefined)?.storageSchema;

const ROOT_KINDS = {
  'loro-map': 'map',
  'loro-list': 'list',
  'loro-movable-list': 'movable_list',
  'loro-text': 'text',
} as const;

/**
 * The `DocSchema` matching a loro-mirror root schema: root kinds, a rule for
 * every declared text or movable list below the roots (`*` for list items and
 * catch-all map keys), and `$cid` on movable-list map items (their identity).
 */
export function engineDocSchemaFromMirror(root: { readonly definition: object }): DocSchema {
  const roots: Record<string, (typeof ROOT_KINDS)[keyof typeof ROOT_KINDS]> = {};
  const rules: { pattern: DocPatternSeg[]; kind: DocNodeKind }[] = [];
  const cidPatterns: DocPatternSeg[][] = [];
  const walk = (node: MirrorNode | undefined, path: DocPatternSeg[]) => {
    if (!node) return;
    if (node.type === 'any') return walk(storageSchemaOf(node), path);
    const nested = path.length > 1;
    if (node.type === 'loro-text' && nested) rules.push({ pattern: path, kind: 'text' });
    if (node.type === 'loro-movable-list') {
      if (nested) rules.push({ pattern: path, kind: 'movable_list' });
      if (node.itemSchema?.type === 'loro-map') cidPatterns.push([...path, '*']);
    }
    for (const [key, child] of Object.entries(
      (node.definition ?? {}) as Record<string, MirrorNode>
    ))
      walk(child, [...path, key === '*' || key === '**' ? { key } : key]);
    if (node.catchallType) walk(node.catchallType, [...path, '*']);
    if (node.itemSchema) walk(node.itemSchema, [...path, '*']);
  };
  for (const [name, node] of Object.entries(root.definition as Record<string, MirrorNode>)) {
    const kind = node.type ? ROOT_KINDS[node.type as keyof typeof ROOT_KINDS] : undefined;
    if (!kind) continue;
    roots[name] = kind;
    walk(node, [name]);
  }
  return {
    roots,
    rules,
    defaultObject: 'map',
    defaultArray: 'list',
    defaultString: 'value',
    cidPatterns,
  };
}
