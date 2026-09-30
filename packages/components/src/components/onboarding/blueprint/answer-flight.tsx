import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { motion } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, text } from '@lody/ui/tokens/scales.stylex';

// The answer, carried to where it lives.
//
// Picking an agent or a project lifts the choice out of the question as a
// small raised chip and flies it, on an arc, into the part of the real window
// it configures. The ink starts where it lands. The motion is the explanation:
// "this choice is that control", without a sentence saying so.

export type Flight = {
  /** Changes per launch, so a second pick restarts the flight. */
  id: number;
  /** Where the chip lifts from, in viewport pixels. */
  from: DOMRect;
  /** Where it lands; resolved at launch. */
  to: () => HTMLElement | null;
  label: ReactNode;
  onLand: () => void;
};

const styles = stylex.create({
  chip: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    paddingInline: '10px',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.medium,
    borderRadius: radius.full,
    color: colors.label,
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    transformOrigin: '0 50%',
  },
});

export function AnswerFlight({
  stageRef,
  flight,
}: {
  stageRef: RefObject<HTMLElement | null>;
  flight: Flight | null;
}): React.JSX.Element | null {
  const [path, setPath] = useState<{
    id: number;
    x: number[];
    y: number[];
  } | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!flight || !stage) {
      setPath(null);
      return undefined;
    }
    const stageRect = stage.getBoundingClientRect();
    const target = flight.to()?.getBoundingClientRect();
    const x0 = flight.from.left - stageRect.left;
    const y0 = flight.from.top + flight.from.height / 2 - 14 - stageRect.top;
    if (!target) {
      flight.onLand();
      setPath(null);
      return undefined;
    }
    const x1 = target.left - stageRect.left;
    const y1 = target.top + target.height / 2 - 14 - stageRect.top;
    // Lift first, then fall onto the target: an arc whose height follows the
    // distance, so a short hop stays a hop.
    const lift = Math.min(90, 24 + Math.hypot(x1 - x0, y1 - y0) * 0.12);
    setPath({
      id: flight.id,
      x: [x0, x0 + (x1 - x0) * 0.45, x1],
      y: [y0, Math.min(y0, y1) - lift, y1],
    });
    // Land a beat before the chip has faded, so the ink rises out of it.
    const land = window.setTimeout(flight.onLand, 500);
    return () => window.clearTimeout(land);
  }, [flight, stageRef]);

  if (!flight || !path || path.id !== flight.id) return null;
  return (
    <motion.div
      key={flight.id}
      {...stylex.props(styles.chip)}
      initial={{ x: path.x[0], y: path.y[0], scale: 1, opacity: 0 }}
      animate={{
        x: path.x,
        y: path.y,
        scale: [1, 1.08, 0.94],
        opacity: [1, 1, 0],
      }}
      transition={{
        duration: 0.62,
        ease: [0.3, 0, 0.15, 1],
        times: [0, 0.45, 1],
        opacity: { duration: 0.62, times: [0, 0.82, 1] },
      }}
    >
      {flight.label}
    </motion.div>
  );
}
