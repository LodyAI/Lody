import type { ConversationView } from './types';

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

/** One React update per frame no matter how many doc events arrived. */
export function subscribeConversationViewOnFrame(
  view: ConversationView,
  onChange: () => void,
  scheduler: FrameScheduler = frameScheduler
): () => void {
  let frame: number | null = null;
  const unsubscribe = view.subscribe(() => {
    if (frame !== null) return;
    frame = scheduler.request(() => {
      frame = null;
      onChange();
    });
  });
  return () => {
    unsubscribe();
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
  };
}

