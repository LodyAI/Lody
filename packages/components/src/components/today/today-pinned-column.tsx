import * as stylex from '@stylexjs/stylex';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { navigationSidebarVisibleAtom } from '@/atoms/layout-state';
import { WORKSPACE_FRAME_CSS } from '@/lib/workspace-frame';
import { DocumentStyle } from '../document-style';
import {
  TODAY_COLUMN_MAX_WIDTH,
  TODAY_COLUMN_MIN_WIDTH,
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
    minWidth: 0,
  },
  // The page card's material and geometry (WorkspaceCard): a darker inset sheet
  // with the same rim, radius and 4px window ground around it, so Today and the
  // main page read as two pages rather than one fused panel.
  card: {
    '--lody-frame-gutter': space[1],
    '--lody-frame-radius': radius.large,
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
  },
  // Over the 4px of window ground between this card and the main one.
  sash: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -1,
    width: 6,
    cursor: 'col-resize',
    zIndex: 5,
    ':hover': { backgroundColor: colors.separator },
  },
});

/**
 * Today pinned next to the left sidebar, in its own page card beside the main
 * one (anchored to the sidebar like the main card, 4px of window ground
 * between the two cards). It keeps its own member/date state and stays mounted while the main
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
  const sidebarVisible = useAtomValue(navigationSidebarVisibleAtom);
  const clamp = (value: number) =>
    Math.min(Math.max(Math.round(value), TODAY_COLUMN_MIN_WIDTH), TODAY_COLUMN_MAX_WIDTH);
  return (
    <TodayPinnedCard
      width={clamp(width)}
      anchored={sidebarVisible}
      label={t('today.nav', 'Today')}
      sash={
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
      }
    >
      <TodayView
        target={target}
        onNavigate={setTarget}
        pinned
        onTogglePin={() => setPinned(false)}
      />
    </TodayPinnedCard>
  );
}

/**
 * The pinned column's shell: a page card with the main card's material and
 * geometry, anchored to the sidebar while it shows. Shared with Storybook.
 */
export function TodayPinnedCard(props: {
  width: number;
  anchored: boolean;
  label: string;
  sash?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      {...stylex.props(styles.column)}
      style={{ width: props.width }}
      aria-label={props.label}
      data-testid="today-column"
    >
      <DocumentStyle name="lody-workspace-frame" css={WORKSPACE_FRAME_CSS} />
      <div
        className={`lody-workspace-card ${stylex.props(styles.card).className ?? ''}`}
        data-anchored={props.anchored}
        data-today-card=""
      >
        {props.children}
      </div>
      {props.sash}
    </section>
  );
}
