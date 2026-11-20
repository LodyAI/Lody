import * as stylex from '@stylexjs/stylex';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  TODAY_COLUMN_MAX_WIDTH,
  TODAY_COLUMN_MIN_WIDTH,
  TODAY_FOCUS_EVENT,
  todayColumnWidthAtom,
  todayPinnedAtom,
  todayPinnedTargetAtom,
} from '@/atoms/sidebar-state';
import { TodayView, type TodayViewTarget } from './today-view';

const styles = stylex.create({
  column: {
    position: 'relative',
    height: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingTop: 8,
  },
  sash: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -3,
    width: 6,
    cursor: 'col-resize',
    zIndex: 5,
    ':hover': { backgroundColor: colors.separator },
  },
});

/**
 * Today pinned next to the left sidebar, on the window ground rather than a
 * card. It keeps its own member/date state and stays mounted while the main
 * area navigates. Behavior: specs/today-outline.md (Switch and entry).
 */
export function TodayPinnedColumn() {
  const { t } = useTranslation();
  const [width, setWidth] = useAtom(todayColumnWidthAtom);
  const setPinned = useSetAtom(todayPinnedAtom);
  const [target, setTarget] = useState<TodayViewTarget>({});
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const linked = useAtomValue(todayPinnedTargetAtom);
  const clearLinked = useSetAtom(todayPinnedTargetAtom);
  useEffect(() => {
    if (!linked) return;
    setTarget(linked);
    clearLinked(null);
  }, [clearLinked, linked]);
  useEffect(() => {
    const backToToday = () => setTarget({});
    window.addEventListener(TODAY_FOCUS_EVENT, backToToday);
    return () => window.removeEventListener(TODAY_FOCUS_EVENT, backToToday);
  }, []);
  const clamp = (value: number) =>
    Math.min(Math.max(Math.round(value), TODAY_COLUMN_MIN_WIDTH), TODAY_COLUMN_MAX_WIDTH);
  return (
    <section
      {...stylex.props(styles.column)}
      style={{ width: clamp(width) }}
      aria-label={t('today.title', 'Today')}
      data-testid="today-column"
    >
      <TodayView
        target={target}
        onNavigate={setTarget}
        pinned
        onTogglePin={() => setPinned(false)}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={TODAY_COLUMN_MIN_WIDTH}
        aria-valuemax={TODAY_COLUMN_MAX_WIDTH}
        aria-valuenow={clamp(width)}
        aria-label={t('today.resize', 'Resize Today')}
        tabIndex={0}
        {...stylex.props(styles.sash)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: clamp(width) };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setWidth(clamp(drag.current.startWidth + event.clientX - drag.current.startX));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setWidth(clamp(width - 16));
          else if (event.key === 'ArrowRight') setWidth(clamp(width + 16));
          else return;
          event.preventDefault();
        }}
      />
    </section>
  );
}
