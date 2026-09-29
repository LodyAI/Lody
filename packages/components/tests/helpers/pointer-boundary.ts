function selfAndAncestors(node: Element): Element[] {
  const chain: Element[] = [];
  for (let current: Element | null = node; current; current = current.parentElement) {
    chain.push(current);
  }
  return chain;
}

/**
 * Moves the pointer from one DOM node to another the way a browser reports it:
 * `pointerout`/`pointerover` bubble from the two ends, then `pointerleave` and
 * `pointerenter` fire on each DOM ancestor actually left or entered. jsdom derives
 * neither pair from the other; React synthesizes its enter/leave from the first
 * (along the component tree, portals included) while native listeners take the
 * second (along the DOM), so a faithful test fires both.
 */
export function movePointer(from: Element, to: Element) {
  const left = selfAndAncestors(from).filter((node) => !node.contains(to));
  const entered = selfAndAncestors(to)
    .filter((node) => !node.contains(from))
    .reverse();
  from.dispatchEvent(
    new MouseEvent('pointerout', { bubbles: true, cancelable: true, relatedTarget: to })
  );
  for (const node of left) {
    node.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: to }));
  }
  to.dispatchEvent(
    new MouseEvent('pointerover', { bubbles: true, cancelable: true, relatedTarget: from })
  );
  for (const node of entered) {
    node.dispatchEvent(new MouseEvent('pointerenter', { relatedTarget: from }));
  }
}
