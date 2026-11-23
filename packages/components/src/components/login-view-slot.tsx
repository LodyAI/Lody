import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { animate, frame, motion, useMotionValue, useTransform } from 'framer-motion';

export const LOGIN_TRANSITION = { duration: 0.32, ease: [0.4, 0, 0.2, 1] as const };

const MeasurePanelContext = createContext<(() => void) | null>(null);

/** Both panels stay mounted. One progress value drives translation and height. */
export function LoginViewSlot({
  active,
  reducedMotion,
  onEntered,
  panels,
}: {
  active: 0 | 1;
  reducedMotion: boolean;
  onEntered: () => void;
  panels: [ReactNode, ReactNode];
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const progress = useMotionValue(active);
  const firstHeight = useMotionValue(0);
  const secondHeight = useMotionValue(0);
  const height = useTransform(
    () => firstHeight.get() + (secondHeight.get() - firstHeight.get()) * progress.get()
  );
  const x = useTransform(progress, (value) => `${-value * 50}%`);
  const entered = useRef(onEntered);
  const [measured, setMeasured] = useState(false);
  const [moving, setMoving] = useState(false);
  entered.current = onEntered;

  const measureRef = useRef<() => void>(() => {});
  const scheduleMeasure = useRef(() => frame.postRender(() => measureRef.current())).current;

  useLayoutEffect(() => {
    const measure = () => {
      if (!stageRef.current || !firstRef.current || !secondRef.current) return;
      const first = firstRef.current.getBoundingClientRect().height;
      const second = secondRef.current.getBoundingClientRect().height;
      firstHeight.set(first);
      secondHeight.set(second);
      // Row animations have already written their flow heights. Fit the viewport
      // in this same frame, without another tween or one-frame clipping delay.
      stageRef.current!.style.height = `${first + (second - first) * progress.get()}px`;
      setMeasured(true);
    };
    measureRef.current = measure;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(firstRef.current!);
    observer.observe(secondRef.current!);
    return () => observer.disconnect();
  }, [firstHeight, secondHeight, progress]);

  useLayoutEffect(() => {
    if (reducedMotion || progress.get() === active) {
      progress.set(active);
      setMoving(false);
      if (active === 1) entered.current();
      return undefined;
    }
    setMoving(true);
    const animation = animate(progress, active, {
      ...LOGIN_TRANSITION,
      onComplete: () => {
        setMoving(false);
        if (active === 1) entered.current();
      },
    });
    return () => {
      const current = progress.get();
      animation.stop();
      progress.set(current);
    };
  }, [active, reducedMotion, progress]);

  return (
    <motion.div
      ref={stageRef}
      data-login-stage
      data-login-phase={moving ? 'moving' : 'visible'}
      data-login-active={active}
      {...stylex.props(styles.viewport)}
      style={{ height: measured ? height : 'auto' }}
    >
      <motion.div {...stylex.props(styles.track)} style={{ x }}>
        {panels.map((panel, index) => (
          <div
            key={index}
            ref={index === 0 ? firstRef : secondRef}
            data-login-panel={index}
            inert={active !== index}
            aria-hidden={active !== index}
            {...stylex.props(styles.panel)}
          >
            <MeasurePanelContext.Provider value={scheduleMeasure}>
              {panel}
            </MeasurePanelContext.Provider>
          </div>
        ))}
      </motion.div>
    </motion.div>
  );
}

/** Animate the flow height without remounting sibling inputs or scaling text. */
export function LoginExpandingRow({
  open,
  reducedMotion,
  children,
  contentKey,
}: {
  open: boolean;
  reducedMotion: boolean;
  children: ReactNode;
  contentKey?: string;
}) {
  const measure = useContext(MeasurePanelContext);
  const innerRef = useRef<HTMLDivElement>(null);
  const height = useMotionValue(0);
  const initialized = useRef(false);
  const [measured, setMeasured] = useState(false);
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    const target = open ? innerRef.current!.getBoundingClientRect().height : 0;
    if (!initialized.current || reducedMotion || target === height.get()) {
      initialized.current = true;
      height.set(target);
      setMeasured(true);
      setMoving(false);
      measure?.();
      return undefined;
    }
    setMoving(true);
    const animation = animate(height, target, {
      ...LOGIN_TRANSITION,
      onComplete: () => setMoving(false),
    });
    return () => {
      const current = height.get();
      animation.stop();
      height.set(current);
    };
  }, [open, reducedMotion, contentKey, height, measure]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      // Font and viewport changes update the intrinsic target. During a row
      // transition the running numeric height remains the sole owner.
      if (!moving) {
        height.set(open ? innerRef.current!.getBoundingClientRect().height : 0);
        measure?.();
      }
    });
    observer.observe(innerRef.current!);
    return () => observer.disconnect();
  }, [open, moving, height, measure]);

  return (
    <motion.div
      onUpdate={measure ?? undefined}
      data-login-row={moving ? 'moving' : 'visible'}
      style={{ height: measured ? height : open ? 'auto' : 0 }}
      inert={!open}
      aria-hidden={!open}
      {...stylex.props(styles.row)}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}

const styles = stylex.create({
  viewport: {
    overflow: 'hidden',
    // Leave room for control focus rings while clipping the offscreen panel.
    marginInline: '-4px',
  },
  track: {
    display: 'flex',
    alignItems: 'flex-start',
    width: '200%',
  },
  panel: {
    boxSizing: 'border-box',
    width: '50%',
    flexShrink: 0,
    paddingInline: '4px',
    paddingBlock: '4px',
  },
  row: {
    overflow: 'hidden',
    marginInline: '-4px',
    paddingInline: '4px',
  },
});
