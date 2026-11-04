import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The new-chat page's stage (`web-chat-landing-screen.tsx`): the scrolling area above the docked
 * composer, and the centred group in it (heading, ambient boards, context switch). Something in
 * the group that can change its own height, the home boards, reads it to know how much room the
 * window leaves it. `null` outside a landing (stories, tests): no limit.
 */
export type LandingStage = { stage: HTMLElement; group: HTMLElement };

export const LandingStageContext = createContext<LandingStage | null>(null);

/** Space kept free above and below the group, so the heading never sits on the window's edge. */
export const LANDING_STAGE_BREATHING_PX = 24;

/**
 * The height `target` may take without the stage scrolling: the stage's height less everything
 * else in the group. That difference does not depend on `target`'s own height, so a target that
 * resizes itself to fit settles at once instead of chasing its own measurement. `null` without a
 * stage, or before the first measure.
 */
export function useLandingRoom(target: RefObject<HTMLElement | null>): number | null {
  const landing = useContext(LandingStageContext);
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!landing) {
      setRoom(null);
      return undefined;
    }
    const { stage, group } = landing;
    const measure = () => {
      const element = target.current;
      // A target may hang out of the group with a negative bottom margin (the home boards);
      // what it takes back is its own, not the rest's.
      const margin = element ? Number.parseFloat(getComputedStyle(element).marginBottom) || 0 : 0;
      const own = (element?.offsetHeight ?? 0) + margin;
      const rest = group.offsetHeight - own;
      setRoom(Math.max(0, stage.clientHeight - rest - LANDING_STAGE_BREATHING_PX));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(group);
    return () => observer.disconnect();
  }, [landing, target]);

  return room;
}
