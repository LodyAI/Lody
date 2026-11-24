/**
 * Where a dnd-kit pointer drag is now: the activating pointer event moved by
 * the drag's travel. `null` when the drag did not start from a pointer.
 */
export function dndPointerPoint(event: {
  activatorEvent: Event | null;
  delta: { x: number; y: number };
}): { x: number; y: number } | null {
  const source = event.activatorEvent;
  if (!source || !('clientX' in source) || !('clientY' in source)) return null;
  const { clientX, clientY } = source as { clientX: unknown; clientY: unknown };
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  return { x: clientX + event.delta.x, y: clientY + event.delta.y };
}
