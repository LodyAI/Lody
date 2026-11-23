type FrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
};

const frameScheduler: FrameScheduler =
  typeof requestAnimationFrame === 'function'
    ? {
        request: (callback) => requestAnimationFrame(() => callback()),
        cancel: (id) => cancelAnimationFrame(id),
      }
    : {
        request: (callback) => setTimeout(callback, 0) as unknown as number,
        cancel: (id) => clearTimeout(id),
      };

/**
 * One React update per frame no matter how many changes arrived. Takes any
 * `subscribe(listener)` source — a `ConversationView`, a
 * `ConversationDerivation` — because the change argument is never read.
 */
export function subscribeOnFrame(
  subscribe: (listener: () => void) => () => void,
  onChange: () => void
): () => void {
  let frame: number | null = null;
  const unsubscribe = subscribe(() => {
    if (frame !== null) return;
    frame = frameScheduler.request(() => {
      frame = null;
      onChange();
    });
  });
  return () => {
    unsubscribe();
    if (frame !== null) frameScheduler.cancel(frame);
    frame = null;
  };
}
