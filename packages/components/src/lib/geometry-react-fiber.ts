/**
 * Which component wrote a rendered element. A geometry finding names a DOM
 * description a designer recognises but an agent cannot open; the React fiber
 * still remembers the component, so a repair ticket can point at source.
 *
 * Everything here is EVIDENCE, never identity: a finding key must not move
 * because a component was renamed, so nothing in this file may reach a key.
 * React 19 dropped `_debugSource`, so a component NAME is the whole pointer —
 * there is no file or line to read, and guessing one would be worse than none.
 *
 * Keep these functions closure-free: capture serializes them into the page.
 */

/** A fiber, as much of one as reading a component name needs. */
export type GeometryReactFiberLike = Readonly<{
  type?: unknown;
  return?: GeometryReactFiberLike | null;
}>;

/**
 * The component name a fiber `type` carries, unwrapping the `memo` and
 * `forwardRef` objects React puts in `type`'s place. A host element (`'div'`)
 * and an anonymous function have no name to give and return undefined, so the
 * walk keeps going up rather than reporting a blank.
 */
export function geometryReactFiberComponentName(
  fiber: GeometryReactFiberLike | null | undefined,
  maxDepth = 64
): string | undefined {
  const typeName = (type: unknown, unwrapDepth: number): string | undefined => {
    if (!type || unwrapDepth > 8) return undefined;
    if (typeof type === 'function') {
      const named = type as Readonly<{ displayName?: unknown; name?: unknown }>;
      const display = typeof named.displayName === 'string' ? named.displayName : undefined;
      const intrinsic = typeof named.name === 'string' ? named.name : undefined;
      const resolved = display ?? intrinsic;
      return resolved && resolved.length > 0 ? resolved : undefined;
    }
    if (typeof type !== 'object') return undefined;
    const wrapper = type as Readonly<{ displayName?: unknown; render?: unknown; type?: unknown }>;
    if (typeof wrapper.displayName === 'string' && wrapper.displayName.length > 0) {
      return wrapper.displayName;
    }
    // `forwardRef` keeps the component on `render`, `memo` on `type`.
    return typeName(wrapper.render, unwrapDepth + 1) ?? typeName(wrapper.type, unwrapDepth + 1);
  };
  let node = fiber;
  for (let depth = 0; node && depth < maxDepth; depth += 1) {
    const name = typeName(node.type, 0);
    if (name) return name;
    node = node.return;
  }
  return undefined;
}

/**
 * The fiber React attached to a rendered node. The key carries a per-renderer
 * suffix, so it is found by prefix rather than spelled out.
 */
export function geometryElementReactFiber(element: Element): GeometryReactFiberLike | undefined {
  for (const key of Object.keys(element)) {
    if (!key.startsWith('__reactFiber$')) continue;
    const fiber = (element as unknown as Record<string, unknown>)[key];
    if (fiber && typeof fiber === 'object') return fiber as GeometryReactFiberLike;
  }
  return undefined;
}
