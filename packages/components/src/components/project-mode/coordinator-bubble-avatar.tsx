import * as stylex from '@stylexjs/stylex';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import coordinatorIdleAvatarUrl from '../../assets/coordinator-avatar/idle.png';
import {
  claimCoordinatorBubbleAvatarPlayback,
  inferCoordinatorBubbleMood,
  type CoordinatorAvatarMood,
  type CoordinatorBubbleMoodSource,
} from './coordinator-avatar-mood';
import {
  mountCoordinatorLottieOnce,
  type CoordinatorLottieData,
} from './coordinator-lottie-player';

const AVATAR_SIZE_PX = 32;

const lottieCache = new Map<CoordinatorAvatarMood, CoordinatorLottieData>();

export async function loadCoordinatorAvatarMoodData(
  mood: CoordinatorAvatarMood
): Promise<CoordinatorLottieData> {
  const cached = lottieCache.get(mood);
  if (cached) {
    return cached;
  }
  let loaded: unknown;
  switch (mood) {
    case 'thinking':
      loaded = await import('../../assets/coordinator-avatar/thinking.json');
      break;
    case 'happy':
      loaded = await import('../../assets/coordinator-avatar/happy.json');
      break;
    case 'confused':
      loaded = await import('../../assets/coordinator-avatar/confused.json');
      break;
    case 'sad':
      loaded = await import('../../assets/coordinator-avatar/sad.json');
      break;
    case 'angry':
      loaded = await import('../../assets/coordinator-avatar/angry.json');
      break;
  }
  const resolved =
    loaded && typeof loaded === 'object' && 'default' in loaded && loaded.default
      ? loaded.default
      : loaded;
  const data = resolved as CoordinatorLottieData;
  lottieCache.set(mood, data);
  return data;
}

const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export interface CoordinatorBubbleAvatarProps {
  readonly scopeKey: string;
  readonly bubbleKey: string;
  readonly entry: CoordinatorBubbleMoodSource;
  readonly createdAt?: number;
}

/**
 * 32 × 32 coordinator jellyfish bubble avatar.
 *
 * Plays the content-selected Lottie (`thinking`, `happy`, `confused`, `sad`, or
 * `angry`) once on a genuinely new message event and seamlessly returns to the
 * static `idle.png` frame afterwards. Historical messages, virtualized remounts,
 * and reduced-motion hosts remain static on `idle.png`.
 */
export const CoordinatorBubbleAvatar = memo(function CoordinatorBubbleAvatar({
  scopeKey,
  bubbleKey,
  entry,
  createdAt,
}: CoordinatorBubbleAvatarProps) {
  const mood = useMemo(() => inferCoordinatorBubbleMood(entry), [entry]);
  const [shouldAnimate, setShouldAnimate] = useState<boolean>(() => {
    if (prefersReducedMotion()) {
      return false;
    }
    return claimCoordinatorBubbleAvatarPlayback(scopeKey, bubbleKey, createdAt);
  });
  const [svgVisible, setSvgVisible] = useState(false);
  const lottieHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!shouldAnimate) {
      setSvgVisible(false);
      return undefined;
    }
    let cancelled = false;
    let teardownPlayer: (() => void) | undefined;

    void loadCoordinatorAvatarMoodData(mood)
      .then((data) => {
        if (cancelled || !lottieHostRef.current) {
          return;
        }
        teardownPlayer = mountCoordinatorLottieOnce({
          container: lottieHostRef.current,
          data,
          size: AVATAR_SIZE_PX,
          onComplete: () => {
            if (!cancelled) {
              setSvgVisible(false);
              setShouldAnimate(false);
            }
          },
        });
        setSvgVisible(true);
      })
      .catch(() => {
        if (!cancelled) {
          setSvgVisible(false);
          setShouldAnimate(false);
        }
      });

    return () => {
      cancelled = true;
      teardownPlayer?.();
    };
  }, [mood, shouldAnimate]);

  return (
    <div
      {...stylex.props(styles.root)}
      data-coordinator-bubble-avatar=""
      data-avatar-mood={mood}
      data-avatar-state={svgVisible ? 'playing' : 'idle'}
      aria-hidden="true"
    >
      <img
        src={coordinatorIdleAvatarUrl}
        alt=""
        width={AVATAR_SIZE_PX}
        height={AVATAR_SIZE_PX}
        draggable={false}
        decoding="sync"
        {...stylex.props(styles.idleImage, svgVisible && styles.hidden)}
      />
      {shouldAnimate ? (
        <div
          ref={lottieHostRef}
          {...stylex.props(styles.lottieOverlay, !svgVisible && styles.hidden)}
        />
      ) : null}
    </div>
  );
});

const styles = stylex.create({
  root: {
    position: 'relative',
    width: AVATAR_SIZE_PX,
    height: AVATAR_SIZE_PX,
    flexShrink: 0,
    marginTop: 2,
    userSelect: 'none',
    pointerEvents: 'none',
  },
  idleImage: {
    display: 'block',
    width: AVATAR_SIZE_PX,
    height: AVATAR_SIZE_PX,
    objectFit: 'contain',
    userSelect: 'none',
  },
  hidden: {
    opacity: 0,
  },
  lottieOverlay: {
    position: 'absolute',
    inset: 0,
    width: AVATAR_SIZE_PX,
    height: AVATAR_SIZE_PX,
  },
});
