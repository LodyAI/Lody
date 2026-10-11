import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import NumberFlow from '@number-flow/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import * as stylex from '@stylexjs/stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Box, Copy, Download, FileText, MousePointerClick, X } from 'lucide-react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Avatar } from '@lody/ui/avatar';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import type {
  SettingsUsageCalendarData,
  SettingsUsageDayData,
  SettingsUsageTimelineData,
} from './settings-data-cache';
import {
  createUsageCalendarModel,
  createUsageHeatScale,
  createUsageSkylineLodyLogoTriangles,
  createUsageSkylineAscii,
  createUsageSkylineBinaryStl,
  getUsageColumnHeight,
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
  USAGE_SKYLINE_STL_BACK_MARGIN,
  USAGE_SKYLINE_STL_BASE_DEPTH,
  USAGE_SKYLINE_STL_BASE_HEIGHT,
  USAGE_SKYLINE_STL_BASE_WIDTH,
  USAGE_SKYLINE_STL_CELL_SIZE,
  USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER,
  type UsageCalendarCell,
  type UsageCalendarMetric,
  type UsageCalendarModel,
} from './usage-calendar-model';
import { HEATMAP_COLUMN_TEMPLATE, HEATMAP_MIN_TRACK_WIDTH } from './usage-calendar-geometry';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
  formatUsageTimelineBucketInterval,
  formatUsageTimelineWindow,
  usageTimelineHourLabels,
} from './usage-timeline-bucket-label';
// Export generation remains available in code while the settings UI focuses on the active views.
const SHOW_SKYLINE_EXPORTS = false;

const heatmapCellIn = stylex.keyframes({
  from: { opacity: 0, transform: 'scale(0.45)' },
  to: { opacity: 1, transform: 'scale(1)' },
});
const loadingPulse = stylex.keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.5 },
});

const usageCellMarker = stylex.defaultMarker();

const styles = stylex.create({
  segmented: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    padding: '2px',
  },
  segmentSelected: {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    boxShadow:
      '0 0 0 1px color-mix(in oklab, hsl(var(--border)) 70%, transparent), 0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  minWidth: { minWidth: 0 },
  peakShare: { color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)' },
  segmentedItem: {
    borderRadius: '5px',
    paddingBlock: '4px',
    paddingInline: '10px',
    fontSize: '12px',
    lineHeight: '1rem',
    fontWeight: 400,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    color: 'hsl(var(--muted-foreground))',
    ':hover': { color: 'hsl(var(--foreground))' },
  },
  summaryComposition: { marginBottom: '24px' },
  emptyRow: {
    height: '1px',
    width: '100%',
    backgroundColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
  },
  legend: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '8px',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  legendRamp: { width: '80px', height: '8px', borderRadius: '9999px' },
  minWidthZero: { minWidth: 0 },
  hourAxis: {
    display: 'grid',
    gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
    columnGap: '3px',
    marginTop: '6px',
  },
  hourLabel: {
    textAlign: 'center',
    fontSize: '9px',
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
  },
  hourGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
    columnGap: '3px',
  },
  dayCell: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    alignItems: 'flex-end',
    cursor: 'pointer',
    borderRadius: '3px',
    outline: 'none',
    '@media (hover: hover)': {
      ':hover': {
        backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground)) 6%, transparent)',
      },
    },
    ':focus-visible': { boxShadow: 'none' },
  },
  dayBar: {
    position: 'relative',
    width: '100%',
    borderTopLeftRadius: '3px',
    borderTopRightRadius: '3px',
    transitionProperty: 'height, background-color',
    transitionDuration: '300ms',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  selectedMark: { boxShadow: '0 0 0 1px hsl(var(--foreground))' },
  dayBarInteractive: {
    '@media (hover: hover)': {
      filter: {
        default: 'none',
        [stylex.when.ancestor(':hover')]: 'brightness(1.1)',
      },
    },
    boxShadow: {
      default: 'none',
      [stylex.when.ancestor(':focus-visible')]: '0 0 0 2px hsl(var(--ring))',
    },
  },
  weekDotInteractive: {
    '@media (hover: hover)': {
      filter: {
        default: 'none',
        [stylex.when.ancestor(':hover')]: 'brightness(1.1)',
      },
      boxShadow: {
        default: 'none',
        [stylex.when.ancestor(':hover')]:
          '0 0 0 1px color-mix(in oklab, hsl(var(--foreground)) 40%, transparent)',
      },
    },
    boxShadow: {
      default: 'none',
      [stylex.when.ancestor(':focus-visible')]: '0 0 0 2px hsl(var(--ring))',
    },
  },
  /** Tallest an hour bar gets; the seven day rows land near the same block. */
  dayTrack: { height: '148px' },
  /** Seven rows land near the 24h bar block at this pitch. */
  weekRow: { height: '18px' },
  weekMatrix: { display: 'flex', gap: space[2] },
  dayGutter: { display: 'flex', flexShrink: 0, flexDirection: 'column', rowGap: '3px' },
  gutterLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: '4px',
    fontSize: '10px',
    lineHeight: 1,
    color: 'hsl(var(--muted-foreground))',
  },
  dimmedText: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 55%, transparent)',
    fontVariantNumeric: 'tabular-nums',
  },
  weekRows: { display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column', rowGap: '3px' },
  weekCell: {
    display: 'flex',
    cursor: 'pointer',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    ':focus-visible': { boxShadow: 'none' },
  },
  weekDot: {
    display: 'block',
    borderRadius: '9999px',
    transitionProperty: 'width, height, background-color, filter',
    transitionDuration: '300ms',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  compositionLabel: {
    margin: 0,
    fontSize: '10px',
    fontWeight: 400,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  compositionTrack: {
    display: 'flex',
    height: '6px',
    columnGap: '1px',
    overflow: 'hidden',
    marginTop: space[1.5],
    borderRadius: '9999px',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground)) 10%, transparent)',
  },
  fullHeight: { height: '100%' },
  compositionLegend: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '10px',
    rowGap: '4px',
    margin: 0,
    marginTop: '6px',
    padding: 0,
    listStyle: 'none',
  },
  compositionItem: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: '4px',
    fontSize: '10px',
  },
  colorDot: { width: '6px', height: '6px', flexShrink: 0, borderRadius: '9999px' },
  truncatedLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  foregroundDim: {
    color: 'color-mix(in oklab, hsl(var(--foreground)) 70%, transparent)',
    fontVariantNumeric: 'tabular-nums',
  },
  compositionSummary: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    columnGap: '24px',
    rowGap: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'color-mix(in oklab, hsl(var(--border)) 50%, transparent)',
    paddingTop: '12px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  ringColumn: { display: 'flex', minWidth: 0, flexDirection: 'column', alignItems: 'center' },
  ringFrame: {
    position: 'relative',
    width: '9.5rem',
    maxWidth: '100%',
    '@media (min-width: 640px)': { width: '10.5rem' },
  },
  ring: { width: '100%', transform: 'rotate(-90deg)' },
  ringCenter: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: '40px',
    textAlign: 'center',
    pointerEvents: 'none',
  },
  ringValue: {
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '15px',
    fontWeight: 400,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.025em',
    color: 'hsl(var(--foreground))',
    '@media (min-width: 640px)': { fontSize: '16px' },
  },
  ringTotalLabel: {
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginTop: '4px',
    fontSize: '9px',
    fontWeight: 400,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
  },
  ringCaption: {
    width: '100%',
    margin: 0,
    marginTop: '12px',
    fontSize: '10px',
    fontWeight: 400,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  ringLegend: {
    display: 'grid',
    width: '100%',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '12px',
    rowGap: '4px',
    margin: 0,
    marginTop: '6px',
    padding: 0,
    listStyle: 'none',
  },
  autoMargin: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 70%, transparent)',
  },
  row: { display: 'flex', minWidth: 0, alignItems: 'center' },
  rowSpace: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: '16px',
    rowGap: '4px',
  },
  smallTabularMuted: {
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  rangeLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  weekColumn: { minWidth: 0, flex: 1 },
  mutedHalf: { color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)' },
  foreground: { color: 'hsl(var(--foreground))' },
  peakLine: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: '12px' },
  rangeFrame: { position: 'relative', minHeight: '10.5rem', minWidth: 0 },
  fixedReadout: {
    display: 'flex',
    height: '20px',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
  },
  rangeSpacing: { marginTop: '12px' },
  rangeReadout: { display: 'flex', height: '20px', alignItems: 'center', marginTop: '12px' },
  readout: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    lineHeight: '1rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  clickHint: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  iconSmall: { width: '14px', height: '14px' },
  iconMedium: { width: '16px', height: '16px' },
  heatmapRoot: { position: 'relative' },
  heatmapLayout: {
    display: 'flex',
    gap: '6px',
    containerType: 'inline-size',
    marginBlockEnd: '12px',
  },
  weekdayGutter: {
    display: 'grid',
    width: '28px',
    flexShrink: 0,
    gridTemplateRows: 'repeat(7, minmax(0, 1fr))',
    rowGap: '4px',
    marginTop: '1rem',
    fontSize: '10px',
    lineHeight: 1,
    color: 'hsl(var(--muted-foreground))',
  },
  scroller: { minWidth: 0, flex: 1, overflowX: 'auto', paddingBottom: '4px' },
  heatmapContent: {
    minWidth: 'var(--usage-heatmap-min-track-width)',
    paddingInline: '2px',
    '@container (min-width: 672px)': { minWidth: 0 },
  },
  monthLabels: {
    display: 'grid',
    columnGap: '4px',
    marginBottom: '6px',
    fontSize: '10px',
    lineHeight: 1,
    color: 'hsl(var(--muted-foreground))',
  },
  noWrap: { whiteSpace: 'nowrap' },
  heatmapGrid: {
    position: 'relative',
    display: 'grid',
    gridTemplateRows: 'repeat(7, minmax(0, 1fr))',
    rowGap: '4px',
    columnGap: '4px',
    gridAutoFlow: 'column',
  },
  heatCell: {
    width: '100%',
    aspectRatio: '1',
    borderRadius: '20%',
    outline: 'none',
    animationName: heatmapCellIn,
    animationDuration: '340ms',
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'backwards',
    transitionProperty: 'filter, opacity',
    transitionDuration: '300ms',
    ':hover': {
      filter: 'brightness(1.1)',
      boxShadow: '0 0 0 1px color-mix(in oklab, hsl(var(--foreground)) 40%, transparent)',
    },
    ':focus-visible': { boxShadow: '0 0 0 2px hsl(var(--ring))' },
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none', transition: 'none' },
  },
  heatCellInteractive: { cursor: 'pointer' },
  heatCellFuture: { cursor: 'default' },
  staticHeatCell: { ':hover': { filter: 'none', boxShadow: 'none' } },
  todayCell: {
    boxShadow: 'inset 0 0 0 1px color-mix(in oklab, hsl(var(--foreground)) 45%, transparent)',
  },
  selectedCell: { boxShadow: '0 0 0 1px hsl(var(--foreground))' },
  todaySelectedCell: {
    boxShadow:
      'inset 0 0 0 1px color-mix(in oklab, hsl(var(--foreground)) 45%, transparent), 0 0 0 1px hsl(var(--foreground))',
  },
  tooltip: {
    position: 'absolute',
    zIndex: 10,
    pointerEvents: 'none',
    transform: 'translate(-50%, -100%)',
    whiteSpace: 'nowrap',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--popover))',
    paddingBlock: '6px',
    paddingInline: '8px',
    fontSize: '11px',
    lineHeight: 1.25,
    color: 'hsl(var(--popover-foreground))',
    boxShadow:
      '0 0 0 1px color-mix(in oklab, hsl(var(--border)) 70%, transparent), 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  },
  tooltipStrong: { fontWeight: 400, fontVariantNumeric: 'tabular-nums' },
  tooltipMuted: {
    marginInlineStart: '6px',
    color: 'color-mix(in oklab, hsl(var(--popover-foreground)) 60%, transparent)',
  },
  tooltipHint: {
    display: 'block',
    marginTop: '2px',
    color: 'color-mix(in oklab, hsl(var(--popover-foreground)) 50%, transparent)',
  },
  rankedRows: { margin: 0, padding: 0, listStyle: 'none' },
  rankedRow: {
    position: 'relative',
    height: '24px',
    marginTop: '4px',
    overflow: 'hidden',
    borderRadius: radius.mini,
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground)) 6%, transparent)',
    ':first-child': { marginTop: 0 },
  },
  rankedFill: { position: 'absolute', insetBlock: 0, left: 0, borderRadius: radius.mini },
  rankedContent: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    gap: '6px',
    paddingInline: '8px',
  },
  rankedName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  rankedValue: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    paddingInlineStart: '8px',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  rankedRest: {
    marginTop: '4px',
    paddingInline: '8px',
    paddingTop: '2px',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  detailPointer: { position: 'relative', paddingTop: '8px' },
  caret: {
    position: 'absolute',
    top: '2px',
    width: '12px',
    height: '12px',
    transform: 'translateX(-50%) rotate(45deg)',
    borderRadius: '2px',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
  },
  detailPanel: {
    position: 'relative',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    padding: space[4],
  },
  detailCloseIcon: {
    width: '14px',
    height: '14px',
    color: 'hsl(var(--muted-foreground))',
  },
  detailGrid: {
    display: 'grid',
    columnGap: space[6],
    rowGap: space[4],
    '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 13rem) minmax(0, 1fr)' },
  },
  twoColumns: {
    display: 'grid',
    columnGap: space[6],
    rowGap: space[4],
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  detailDate: {
    margin: 0,
    fontSize: '11px',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  detailTotal: { display: 'flex', alignItems: 'baseline', gap: '6px', margin: 0, marginTop: '4px' },
  detailValue: {
    fontSize: '24px',
    fontWeight: 400,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  detailUnits: {
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'hsl(var(--muted-foreground))',
  },
  detailCost: {
    minHeight: '16px',
    margin: 0,
    marginTop: '6px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
  detailComposition: {
    display: 'flex',
    height: '6px',
    overflow: 'hidden',
    marginTop: '16px',
    borderRadius: '9999px',
  },
  detailLegend: { margin: 0, marginTop: '8px', padding: 0, listStyle: 'none' },
  detailItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '4px',
    fontSize: '11px',
    ':first-child': { marginTop: 0 },
  },
  detailColorDot: { width: '6px', height: '6px', flexShrink: 0, borderRadius: '9999px' },
  detailPercent: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    fontVariantNumeric: 'tabular-nums',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
  },
  loadingRows: { display: 'flex', flexDirection: 'column', rowGap: '8px', marginTop: '16px' },
  loadingLine: {
    height: '6px',
    borderRadius: '9999px',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground)) 15%, transparent)',
    animationName: loadingPulse,
    animationDuration: '2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  loadingLineShort: { width: '66.666667%' },
  noUsage: {
    margin: 0,
    marginTop: '16px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'hsl(var(--muted-foreground))',
  },
  detailSectionLabel: {
    margin: 0,
    marginBottom: '8px',
    fontSize: '11px',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  iconMuted: {
    width: '12px',
    height: '12px',
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--foreground)) 50%, transparent)',
  },
  statLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  statValue: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    marginTop: '2px',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 400,
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  statDetail: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    fontSize: '11px',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
  },
  summaryStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '16px',
    rowGap: '12px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' },
  },
  skylinePreview: {
    height: '300px',
    overflow: 'hidden',
    borderRadius: 'var(--radius-md)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 35%, transparent)',
    '@media (min-width: 640px)': { height: '360px' },
  },
  canvas: { touchAction: 'none', cursor: 'grab', ':active': { cursor: 'grabbing' } },
  ascii: {
    overflowX: 'auto',
    borderRadius: 'var(--radius-md)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    backgroundColor: '#0d1117',
    padding: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '9px',
    lineHeight: 1.15,
    color: '#39d353',
    userSelect: 'text',
    '@media (min-width: 640px)': { fontSize: '11px' },
  },
  card: {
    overflow: 'hidden',
    borderRadius: 'var(--radius-lg)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--card)) 40%, transparent)',
  },
  cardHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    paddingInline: '16px',
    paddingTop: '16px',
  },
  cardTitle: {
    margin: 0,
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  cardSubtitle: {
    margin: 0,
    marginTop: '2px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'hsl(var(--muted-foreground))',
  },
  controlGroup: { display: 'flex', alignItems: 'center', gap: '6px' },
  cardBody: { padding: '16px' },
  ringLayout: {
    position: 'relative',
    display: 'grid',
    minWidth: 0,
    alignItems: 'center',
    columnGap: '24px',
    rowGap: '20px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'minmax(0, 10.5rem) minmax(0, 1fr)' },
  },
  fullWidth: { width: '100%', minWidth: 0 },
  expandingPanel: {
    display: 'grid',
    transitionProperty: 'grid-template-rows, opacity',
    transitionDuration: '450ms',
    transitionTimingFunction: 'cubic-bezier(0.34, 1.25, 0.64, 1)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  expanded: { gridTemplateRows: '1fr', opacity: 1 },
  collapsed: { gridTemplateRows: '0fr', opacity: 0 },
  hiddenOverflow: { minHeight: 0, overflow: 'hidden' },
  metricBand: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 25%, transparent)',
    paddingBlock: '16px',
    paddingInline: '16px',
    '@media (min-width: 640px)': { paddingInline: '20px' },
  },
  lowerBlock: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '16px',
    padding: '16px',
    ':empty': { display: 'none' },
  },
  exportRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    paddingTop: '12px',
  },
  exportLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  exportActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
});

/**
 * The heatmap paints one theme token at varying alpha instead of a fixed five-step
 * palette, so the ramp reads the same way in light and dark mode and stays smooth.
 * `--chart-1` is the blue anchor of the chart palette and is defined only in the
 * light/dark roots, so it stays blue under themes that repaint `--primary`.
 */
const heatColor = (intensity: number) => `hsl(var(--chart-1) / ${intensity.toFixed(3)})`;
const EMPTY_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.14)';
const FUTURE_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.05)';

/** Product language for compact units — never the host OS default. */
function usageIntlLocale(): string {
  return toIntlLocaleOrEn(i18next.resolvedLanguage ?? i18next.language);
}

function formatTokens(value: number, locale: string = usageIntlLocale()): string {
  return formatCompactNumber(value, locale);
}

function formatCost(value: number, locale: string = usageIntlLocale()): string {
  // Daily costs are often fractions of a cent; two digits would render them all as $0.00.
  return formatUsdAmount(value, locale);
}

function formatMetric(
  value: number,
  metric: UsageCalendarMetric,
  locale: string = usageIntlLocale()
): string {
  return metric === 'tokens' ? formatTokens(value, locale) : formatCost(value, locale);
}

function fileStem(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'lody-usage';
}

function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function SegmentedControl<Value extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: Value;
  onChange: (value: Value) => void;
  options: Array<{ value: Value; label: ReactNode; title?: string }>;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} {...stylex.props(styles.segmented)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          title={option.title}
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          {...stylex.props(styles.segmentedItem, value === option.value && styles.segmentSelected)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Columns that open a new month, thinned out so short month names cannot collide. */
const MIN_COLUMNS_BETWEEN_MONTH_LABELS = 3;
/** Per-week delay of the reveal sweep; 53 weeks land in roughly 0.6s. */
const CELL_REVEAL_STAGGER_MS = 11;

function useCalendarFormats() {
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  return useMemo(
    () => ({
      locale,
      timeline: createUsageTimelineFormatter(locale),
      month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
      /** Compact span endpoints such as "Jul 20"; the year lives in the range label. */
      dayShort: new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      dayOfMonth: new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' }),
      day: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    }),
    [locale]
  );
}

function useMonthLabels(model: UsageCalendarModel, format: Intl.DateTimeFormat) {
  return useMemo(() => {
    const candidates: Array<{ column: number; label: string }> = [];
    let previousMonth = -1;
    for (const [column, week] of model.weeks.entries()) {
      const firstDay = week[0];
      if (!firstDay) continue;
      const month = new Date(firstDay.dayStartMs).getUTCMonth();
      if (month === previousMonth) continue;
      previousMonth = month;
      candidates.push({ column, label: format.format(new Date(firstDay.dayStartMs)) });
    }
    // Thin out from the right so a crowded partial month at the very start is what
    // gets dropped, never the full month that follows it.
    const labels: Array<{ column: number; label: string }> = [];
    let nextLabelColumn = USAGE_CALENDAR_COLUMNS;
    for (const candidate of candidates.reverse()) {
      if (nextLabelColumn - candidate.column < MIN_COLUMNS_BETWEEN_MONTH_LABELS) continue;
      nextLabelColumn = candidate.column;
      labels.unshift(candidate);
    }
    return labels;
  }, [format, model.weeks]);
}

function HeatLegend() {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.legend)}>
      <span>{t('workspace.usage.skyline.less')}</span>
      <span
        aria-hidden="true"
        {...stylex.props(styles.legendRamp)}
        style={{
          backgroundImage: `linear-gradient(to right, ${EMPTY_DAY_COLOR}, ${heatColor(0.2)}, ${heatColor(0.55)}, ${heatColor(1)})`,
        }}
      />
      <span>{t('workspace.usage.skyline.more')}</span>
    </div>
  );
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The range panel keeps its blue deliberately quiet: even the densest hour stops
 * short of the full-saturation chart blue, so a busy week reads as light rather
 * than a solid slab. The year heatmap above still uses the full ramp — it has far
 * more empty space to carry it.
 */
const RANGE_HEAT_FLOOR = 0.18;
const RANGE_HEAT_CEILING = 0.92;
const rangeHeatColor = (intensity: number) =>
  heatColor(RANGE_HEAT_FLOOR + (RANGE_HEAT_CEILING - RANGE_HEAT_FLOOR) * intensity);
const RANGE_EMPTY_COLOR = 'hsl(var(--muted-foreground) / 0.11)';

/**
 * Percentile-anchored so one spike hour cannot flatten a whole week; the gamma
 * lifts the quiet-but-not-empty buckets that a linear ramp loses.
 */
function createRangeIntensity(values: number[]): (value: number) => number {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  const reference = active[Math.min(active.length - 1, Math.ceil((active.length - 1) * 0.9))] ?? 0;
  return (value: number) =>
    value > 0 && reference > 0 ? Math.min(1, value / reference) ** 0.62 : 0;
}

/** Per-track delay of the reveal sweep; the widest range (24 columns) lands in ~0.8s. */
const RANGE_SWEEP_STEP_S = 0.022;
const RANGE_SWEEP_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * One track of the matrix — an hour column in 24h, a day row in 7d. The sweep is
 * a blurred slide that resolves in order, which is what makes the ranges read as
 * one object changing shape rather than three separate charts. Motion lives on
 * the track, not on each of the 168 cells, so the blur stays cheap.
 */
function RangeSweep({
  index,
  reduced,
  axis = 'column',
  children,
}: {
  index: number;
  reduced: boolean;
  axis?: 'column' | 'row';
  children: ReactNode;
}) {
  return (
    <motion.div
      // Presentational: the wrapper only carries the sweep, so the grid still
      // sees its cells directly.
      role="presentation"
      {...stylex.props(styles.minWidth)}
      initial={
        reduced
          ? false
          : { opacity: 0, filter: 'blur(5px)', ...(axis === 'column' ? { y: 6 } : { x: -8 }) }
      }
      animate={{ opacity: 1, x: 0, y: 0, filter: 'blur(0px)' }}
      transition={
        reduced
          ? { duration: 0 }
          : { duration: 0.36, delay: index * RANGE_SWEEP_STEP_S, ease: RANGE_SWEEP_EASE }
      }
    >
      {children}
    </motion.div>
  );
}

/** Hours are labelled every three; a label on all 24 becomes noise. */
const HOUR_LABEL_STEP = 3;
function HourAxis({
  labels = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')),
}: {
  labels?: string[];
}) {
  return (
    <div
      aria-hidden="true"
      {...stylex.props(styles.hourAxis)}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, labels.length)}, minmax(0, 1fr))` }}
    >
      {labels.map((label, index) => (
        <span key={index} {...stylex.props(styles.hourLabel)}>
          {index % HOUR_LABEL_STEP === 0 ? label : ''}
        </span>
      ))}
    </div>
  );
}

/**
 * 24h: a skyline silhouette — one flat bar per hour standing on a baseline, no
 * empty track behind it. Height carries magnitude and the fill's light carries
 * share of the peak. Every bar opens the breakdown of the day it belongs to.
 */
function UsageDayMatrix({
  timeline,
  metric,
  intensityOf,
  reduced,
  selectedCellMs,
  onToggleDay,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  /** Exact hour bucket that opened the breakdown; only it carries the ring. */
  selectedCellMs: number | null;
  onToggleDay: (dayStartMs: number, cellMs: number, element: HTMLElement | null) => void;
}) {
  const { buckets } = timeline;
  const formats = useCalendarFormats();
  const maxValue = buckets.reduce(
    (peak, bucket) => Math.max(peak, metric === 'tokens' ? bucket.tokens : bucket.costUSD),
    0
  );
  // Roving tabindex: the 24 bars are one tab stop, arrow keys walk hours.
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusCell = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(index, 0), buckets.length - 1);
      setFocusIndex(next);
      cellRefs.current[next]?.focus();
    },
    [buckets.length]
  );
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : buckets.length - 1);
    }
  };

  return (
    <div>
      <div
        {...stylex.props(styles.hourGrid)}
        role="row"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0, 1fr))` }}
      >
        {buckets.map((bucket, index) => {
          const value = metric === 'tokens' ? bucket.tokens : bucket.costUSD;
          const intensity = intensityOf(value);
          const height = value > 0 && maxValue > 0 ? Math.max(7, (value / maxValue) * 100) : 0;
          const label = `${formatUsageTimelineBucketInterval(timeline, bucket, formats.timeline)} · ${formatMetric(value, metric)}`;
          const dayStartMs = Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS;
          const selected = bucket.bucketStartMs === selectedCellMs;
          return (
            <RangeSweep key={bucket.bucketStartMs} index={index} reduced={reduced}>
              <button
                ref={(element) => {
                  cellRefs.current[index] = element;
                }}
                type="button"
                role="gridcell"
                tabIndex={index === focusIndex ? 0 : -1}
                title={label}
                aria-label={label}
                aria-selected={selected}
                {...stylex.props(styles.dayCell, styles.dayTrack, usageCellMarker)}
                onClick={(event) =>
                  onToggleDay(dayStartMs, bucket.bucketStartMs, event.currentTarget)
                }
                onKeyDown={(event) => onKeyDown(event, index)}
                onFocus={() => setFocusIndex(index)}
              >
                {/* Ring lives on the bar, not the button: the global focus reset
                    kills ring shadows on any focused element, so a ring on the
                    button would vanish right after the click. */}
                <span
                  aria-hidden="true"
                  {...stylex.props(
                    styles.dayBar,
                    selected && styles.selectedMark,
                    styles.dayBarInteractive
                  )}
                  style={{
                    height: `${height}%`,
                    backgroundColor: rangeHeatColor(intensity),
                  }}
                />
              </button>
            </RangeSweep>
          );
        })}
      </div>
      <div aria-hidden="true" {...stylex.props(styles.emptyRow)} />
      <HourAxis labels={usageTimelineHourLabels(buckets)} />
    </div>
  );
}

const WEEK_DOT_MIN_PX = 5;
const WEEK_DOT_MAX_PX = 13;

/**
 * 7d: the same 24 hour tracks as the 24h view, stacked seven deep. Dots rather
 * than tiles — a circle that grows and brightens with its hour keeps a quiet
 * week readable as texture, where a full-bleed grid turns into a wall. Clicking
 * a dot opens that day's breakdown.
 */
function UsageWeekMatrix({
  timeline,
  metric,
  intensityOf,
  reduced,
  weekdayFormat,
  dayOfMonthFormat,
  selectedCellMs,
  onToggleDay,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  weekdayFormat: Intl.DateTimeFormat;
  dayOfMonthFormat: Intl.DateTimeFormat;
  /** Exact hour cell that opened the breakdown; only it carries the ring. */
  selectedCellMs: number | null;
  onToggleDay: (dayStartMs: number, cellMs: number, element: HTMLElement | null) => void;
}) {
  const startDayMs = Math.floor(timeline.startMs / DAY_MS) * DAY_MS;
  const lastDayMs = Math.floor(Math.max(timeline.startMs, timeline.endMs - 1) / DAY_MS) * DAY_MS;
  const dayStarts = Array.from(
    { length: Math.floor((lastDayMs - startDayMs) / DAY_MS) + 1 },
    (_, index) => startDayMs + index * DAY_MS
  );
  const cellCount = dayStarts.length * 24;
  const formats = useCalendarFormats();
  const valuesByBucket = useMemo(() => {
    const values = new Map<number, number>();
    for (const bucket of timeline.buckets) {
      values.set(bucket.bucketStartMs, metric === 'tokens' ? bucket.tokens : bucket.costUSD);
    }
    return values;
  }, [metric, timeline.buckets]);

  // Roving tabindex: the 7×24 grid is one tab stop, arrow keys walk cells.
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusCell = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(index, 0), cellCount - 1);
      setFocusIndex(next);
      cellRefs.current[next]?.focus();
    },
    [cellCount]
  );
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = {
      ArrowUp: -24,
      ArrowDown: 24,
      ArrowLeft: -1,
      ArrowRight: 1,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : cellCount - 1);
    }
  };

  return (
    <div {...stylex.props(styles.weekMatrix)}>
      {/* Day gutter, outside the rows so the sweep cannot drag the labels. */}
      <div aria-hidden="true" {...stylex.props(styles.dayGutter)}>
        {dayStarts.map((dayStartMs) => (
          <span key={dayStartMs} {...stylex.props(styles.gutterLabel, styles.weekRow)}>
            <span>{weekdayFormat.format(new Date(dayStartMs))}</span>
            <span {...stylex.props(styles.dimmedText)}>
              {dayOfMonthFormat.format(new Date(dayStartMs))}
            </span>
          </span>
        ))}
      </div>
      <div {...stylex.props(styles.weekColumn)}>
        <div {...stylex.props(styles.weekRows)}>
          {dayStarts.map((dayStartMs, dayIndex) => (
            <RangeSweep key={dayStartMs} index={dayIndex} reduced={reduced} axis="row">
              <div {...stylex.props(styles.hourGrid)} role="row">
                {Array.from({ length: 24 }, (_, hour) => {
                  const cellIndex = dayIndex * 24 + hour;
                  const cellMs = dayStartMs + hour * HOUR_MS;
                  const value = valuesByBucket.get(cellMs) ?? 0;
                  const intensity = intensityOf(value);
                  const size =
                    intensity > 0
                      ? WEEK_DOT_MIN_PX + (WEEK_DOT_MAX_PX - WEEK_DOT_MIN_PX) * intensity
                      : WEEK_DOT_MIN_PX - 1;
                  const label = `${formatUsageTimelineBucketLabel(timeline, { bucketStartMs: cellMs, bucketLabel: '' }, formats.timeline)} · ${formatMetric(value, metric)}`;
                  const selected = cellMs === selectedCellMs;
                  return (
                    <button
                      key={hour}
                      ref={(element) => {
                        cellRefs.current[cellIndex] = element;
                      }}
                      type="button"
                      role="gridcell"
                      tabIndex={cellIndex === focusIndex ? 0 : -1}
                      title={label}
                      aria-label={label}
                      aria-selected={selected}
                      // focus-visible:shadow-none opts out of the global inset
                      // primary focus border; the dot carries the focus ring instead.
                      {...stylex.props(styles.weekCell, styles.weekRow, usageCellMarker)}
                      onClick={(event) => onToggleDay(dayStartMs, cellMs, event.currentTarget)}
                      onKeyDown={(event) => onKeyDown(event, cellIndex)}
                      onFocus={() => setFocusIndex(cellIndex)}
                    >
                      <span
                        aria-hidden="true"
                        {...stylex.props(
                          styles.weekDot,
                          selected && styles.selectedMark,
                          styles.weekDotInteractive
                        )}
                        style={{
                          width: size,
                          height: size,
                          backgroundColor:
                            intensity > 0 ? rangeHeatColor(intensity) : RANGE_EMPTY_COLOR,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            </RangeSweep>
          ))}
        </div>
        <HourAxis />
      </div>
    </div>
  );
}

const COMPOSITION_SEGMENT_LIMIT = 5;
const MODEL_SERIES_COLORS = ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'] as const;
const MEMBER_SERIES_COLORS = ['#7c3aed', '#9333ea', '#a855f7', '#c084fc', '#e9d5ff'] as const;

type UsageCompositionSegment = {
  id: string;
  label: string;
  tokens: number;
  share: number;
};

function createUsageCompositionSegments(
  rows: Array<{ id: string; label: string; tokens: number }>,
  otherLabel: string
): UsageCompositionSegment[] {
  const totals = new Map<string, { label: string; tokens: number }>();
  for (const row of rows) {
    if (!Number.isFinite(row.tokens) || row.tokens <= 0) continue;
    const previous = totals.get(row.id);
    totals.set(row.id, {
      label: row.label,
      tokens: (previous?.tokens ?? 0) + row.tokens,
    });
  }

  const sorted = [...totals.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  const visible = sorted.slice(0, COMPOSITION_SEGMENT_LIMIT - 1);
  const hidden = sorted.slice(COMPOSITION_SEGMENT_LIMIT - 1);
  if (hidden.length > 0) {
    visible.push({
      id: '__other__',
      label: otherLabel,
      tokens: hidden.reduce((total, row) => total + row.tokens, 0),
    });
  }

  const total = visible.reduce((sum, row) => sum + row.tokens, 0);
  return visible.map((row) => ({ ...row, share: total > 0 ? row.tokens / total : 0 }));
}

/**
 * A pair of 6px rules carries the by-model and by-member shares inside the
 * panel's own text rhythm, under whichever matrix is on screen.
 */
function UsageCompositionBar({
  label,
  segments,
  colors,
  reduced,
}: {
  label: string;
  segments: UsageCompositionSegment[];
  colors: readonly string[];
  reduced: boolean;
}) {
  return (
    <div {...stylex.props(styles.minWidthZero)}>
      <p {...stylex.props(styles.compositionLabel)}>{label}</p>
      <div {...stylex.props(styles.compositionTrack)}>
        {segments.map((segment, index) => (
          <motion.span
            key={segment.id}
            title={`${segment.label} · ${Math.round(segment.share * 100)}%`}
            {...stylex.props(styles.fullHeight)}
            style={{ backgroundColor: colors[index % colors.length] }}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${segment.share * 100}%` }}
            transition={reduced ? { duration: 0 } : { duration: 0.5, ease: RANGE_SWEEP_EASE }}
          />
        ))}
      </div>
      <ul {...stylex.props(styles.compositionLegend)}>
        {segments.map((segment, index) => (
          <li key={segment.id} {...stylex.props(styles.compositionItem)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.colorDot)}
              style={{ backgroundColor: colors[index % colors.length] }}
            />
            <span {...stylex.props(styles.truncatedLabel)}>{segment.label}</span>
            <span {...stylex.props(styles.foregroundDim)}>{Math.round(segment.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** By-model and by-member rules, shared by every range that has a timeline. */
function UsageCompositionSummary({
  timeline,
  reduced,
}: {
  timeline: SettingsUsageTimelineData;
  reduced: boolean;
}) {
  const { t } = useTranslation();
  const modelSegments = useMemo(
    () =>
      createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byModel.map((row) => ({
            id: row.modelId,
            label: stripRecommended(row.modelId),
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ),
    [t, timeline.buckets]
  );
  const memberSegments = useMemo(
    () =>
      createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byUser.map((row) => ({
            id: row.userId,
            label:
              timeline.users?.[row.userId]?.name ||
              timeline.users?.[row.userId]?.email ||
              row.userId,
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ),
    [t, timeline.buckets, timeline.users]
  );

  return (
    <div {...stylex.props(styles.compositionSummary, styles.summaryComposition)}>
      <UsageCompositionBar
        label={t('workspace.usage.byModel')}
        segments={modelSegments}
        colors={MODEL_SERIES_COLORS}
        reduced={reduced}
      />
      <UsageCompositionBar
        label={t('workspace.usage.byUser')}
        segments={memberSegments}
        colors={MEMBER_SERIES_COLORS}
        reduced={reduced}
      />
    </div>
  );
}

type UsageRingSegment = {
  id: string;
  label: string;
  value: number;
  share: number;
  color: string;
};

/**
 * Ring hues come from the chart palette so they follow the theme; three.js is
 * the only place in this file that needs literal colours.
 */
const RING_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;

const RING_VIEWBOX = 168;
const RING_RADIUS = 66;
const RING_STROKE = 26;
/** Tiny angular gap between donut slices so adjacent colours do not bleed. */
const RING_SLICE_GAP = 0.006;

/**
 * Which composition the rings show. The token-type split is the intended one;
 * it is optional on the timeline contract, so when the range carries no
 * breakdown the rings show the model split and the caption says so. An empty
 * ring stack would read as a broken panel.
 */
function useUsageRingComposition(timeline: SettingsUsageTimelineData | undefined): {
  caption: string;
  segments: UsageRingSegment[];
} | null {
  const { t } = useTranslation();
  return useMemo(() => {
    const breakdown = timeline?.totals.breakdown;
    const typeRows = breakdown
      ? [
          {
            id: 'cache',
            label: t('workspace.usage.breakdown.cache'),
            value: breakdown.cacheReadInputTokens + breakdown.cacheCreationInputTokens,
          },
          {
            id: 'input',
            label: t('workspace.usage.breakdown.input'),
            value: breakdown.inputTokens,
          },
          {
            id: 'output',
            label: t('workspace.usage.breakdown.output'),
            value: breakdown.outputTokens,
          },
          {
            id: 'reasoning',
            label: t('workspace.usage.breakdown.reasoning'),
            value: breakdown.reasoningOutputTokens,
          },
        ].filter((row) => row.value > 0)
      : [];
    const typeTotal = typeRows.reduce((sum, row) => sum + row.value, 0);
    if (typeTotal > 0) {
      return {
        caption: t('workspace.usage.breakdown.title'),
        segments: typeRows.map((row, index) => ({
          ...row,
          share: row.value / typeTotal,
          color: RING_COLORS[index % RING_COLORS.length]!,
        })),
      };
    }

    if (!timeline) return null;

    return {
      caption: t('workspace.usage.byModel'),
      segments: createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byModel.map((row) => ({
            id: row.modelId,
            label: stripRecommended(row.modelId),
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ).map((segment, index) => ({
        id: segment.id,
        label: segment.label,
        value: segment.tokens,
        share: segment.share,
        color: RING_COLORS[index % RING_COLORS.length]!,
      })),
    };
  }, [t, timeline]);
}

/**
 * Single donut ring. The composition slices are arcs of one circle that tile the
 * full 360° — pure share-of-total, with no per-slice track that would read as
 * progress toward a goal that does not exist. The total sits in the middle,
 * which is the number the panel is really about.
 */
function UsageTokenRings({
  segments,
  caption,
  total,
  totalLabel,
  metric,
  reduced,
}: {
  segments: UsageRingSegment[];
  caption: string;
  total: number;
  totalLabel: string;
  metric: UsageCalendarMetric;
  reduced: boolean;
}) {
  const { locale } = useCalendarFormats();
  const center = RING_VIEWBOX / 2;
  const slices = useMemo(() => {
    let start = 0;
    return segments.map((segment) => {
      const slice = { ...segment, start };
      start += segment.share;
      return slice;
    });
  }, [segments]);
  return (
    <div {...stylex.props(styles.ringColumn)}>
      <div {...stylex.props(styles.ringFrame)}>
        <svg
          viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}
          role="img"
          aria-label={`${caption}: ${segments
            .map((segment) => `${segment.label} ${Math.round(segment.share * 100)}%`)
            .join(', ')}`}
          {...stylex.props(styles.ring)}
        >
          <circle
            cx={center}
            cy={center}
            r={RING_RADIUS}
            fill="none"
            stroke="hsl(var(--muted-foreground))"
            strokeOpacity={0.08}
            strokeWidth={RING_STROKE}
          />
          {slices.map((slice, index) => (
            // Each slice is a full circle rotated to its start angle, with
            // pathLength drawing only its share of the circumference.
            <g key={slice.id} transform={`rotate(${slice.start * 360} ${center} ${center})`}>
              <motion.circle
                cx={center}
                cy={center}
                r={RING_RADIUS}
                fill="none"
                stroke={slice.color}
                strokeWidth={RING_STROKE}
                initial={reduced ? false : { pathLength: 0 }}
                animate={{
                  pathLength: Math.max(0.004, slice.share - RING_SLICE_GAP),
                }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.85, delay: 0.06 * index, ease: RANGE_SWEEP_EASE }
                }
              />
            </g>
          ))}
        </svg>
        <div {...stylex.props(styles.ringCenter)}>
          <span {...stylex.props(styles.ringValue)}>
            {metric === 'tokens' ? (
              <NumberFlow
                value={total}
                locales={locale}
                format={{ notation: 'compact', maximumFractionDigits: 1 }}
              />
            ) : (
              formatCost(total, locale)
            )}
          </span>
          <span {...stylex.props(styles.ringTotalLabel)}>{totalLabel}</span>
        </div>
      </div>

      <p {...stylex.props(styles.ringCaption)}>{caption}</p>
      <ul {...stylex.props(styles.ringLegend)}>
        {segments.map((segment) => (
          <li key={segment.id} {...stylex.props(styles.compositionItem)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.colorDot)}
              style={{ backgroundColor: segment.color }}
            />
            <span {...stylex.props(styles.truncatedLabel)}>{segment.label}</span>
            <span {...stylex.props(styles.autoMargin)}>{Math.round(segment.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The hourly range view. 24h and 7d share one frame — the donut ring is a
 * persistent sibling rendered by the parent, so switching between them only
 * deforms the matrix. 30d and all-time hand off to the year skyline. Cells open
 * the same day breakdown the heatmap offers; composition rules live in the
 * metrics band.
 */
function UsageRangePanel({
  timeline,
  metric,
  selectedDayMs,
  onSelectDay,
  onMoveDayAnchor,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
  selectedDayMs: number | null;
  onSelectDay: (day: UsageSelectedDay | null) => void;
  onMoveDayAnchor: (day: UsageSelectedDay) => void;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const reduced = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedCellRef = useRef<HTMLElement | null>(null);
  const [selectedCellMs, setSelectedCellMs] = useState<number | null>(null);

  const values = useMemo(
    () => timeline.buckets.map((bucket) => (metric === 'tokens' ? bucket.tokens : bucket.costUSD)),
    [metric, timeline.buckets]
  );
  const intensityOf = useMemo(() => createRangeIntensity(values), [values]);
  const peakIndex = values.reduce(
    (peak, value, index) => (value > (values[peak] ?? 0) ? index : peak),
    0
  );
  const peakBucket = timeline.buckets[peakIndex];
  const activeCount = values.filter((value) => value > 0).length;

  const spanLabel = formatUsageTimelineWindow(timeline, formats.timeline);

  /** Caret x for a cell, in coordinates of the panel root the detail panel shares. */
  const measureAnchorX = useCallback((element: HTMLElement | null) => {
    const root = rootRef.current;
    if (!element || !root) return 0;
    const cellRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - rootRect.left;
  }, []);

  const toggleDay = useCallback(
    (dayStartMs: number, cellMs: number, element: HTMLElement | null) => {
      // Only the very cell that opened the breakdown closes it again; any other
      // cell switches the selection in place, even within the same day (in 24h
      // every bar usually shares one day, so a day-level compare would close
      // the panel on every second click).
      if (cellMs === selectedCellMs) {
        selectedCellRef.current = null;
        setSelectedCellMs(null);
        onSelectDay(null);
        return;
      }
      selectedCellRef.current = element;
      setSelectedCellMs(cellMs);
      onSelectDay({ dayStartMs, anchorX: measureAnchorX(element) });
    },
    [measureAnchorX, onSelectDay, selectedCellMs]
  );

  // The ring marks the exact cell that opened the breakdown; it dies with the
  // selection (e.g. when a range switch clears it from above).
  useEffect(() => {
    if (selectedDayMs === null) setSelectedCellMs(null);
  }, [selectedDayMs]);

  // The caret must follow its cell when the panel resizes.
  useEffect(() => {
    if (selectedDayMs === null) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const sync = () => {
      const element = selectedCellRef.current;
      if (!element || !root.contains(element)) return;
      onMoveDayAnchor({ dayStartMs: selectedDayMs, anchorX: measureAnchorX(element) });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureAnchorX, onMoveDayAnchor, selectedDayMs]);

  const selectedDayTotal = useMemo(() => {
    if (selectedDayMs === null) return null;
    let total = 0;
    for (const bucket of timeline.buckets) {
      if (Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS === selectedDayMs) {
        total += metric === 'tokens' ? bucket.tokens : bucket.costUSD;
      }
    }
    return total;
  }, [metric, selectedDayMs, timeline.buckets]);

  return (
    <div ref={rootRef} {...stylex.props(styles.minWidthZero)}>
      <div {...stylex.props(styles.rowSpace)}>
        <p title={spanLabel} {...stylex.props(styles.rangeLabel)}>
          {spanLabel}
          <span {...stylex.props(styles.mutedHalf)}>
            {` · ${t('workspace.usage.skyline.activeIntervals')} ${activeCount}/${values.length}`}
          </span>
        </p>
        <div {...stylex.props(styles.peakLine)}>
          {peakBucket && (values[peakIndex] ?? 0) > 0 ? (
            <p {...stylex.props(styles.smallTabularMuted)}>
              <span
                {...stylex.props(styles.mutedHalf)}
              >{`${t('workspace.usage.skyline.peakInterval')} `}</span>
              <span {...stylex.props(styles.foreground)}>
                {formatMetric(values[peakIndex] ?? 0, metric)}
              </span>
              <span
                {...stylex.props(styles.mutedHalf)}
              >{` · ${formatUsageTimelineBucketLabel(timeline, peakBucket, formats.timeline)}`}</span>
            </p>
          ) : null}
          <HeatLegend />
        </div>
      </div>

      {/* The donut ring lives outside this panel (and outside the range-switch
          cross-fade) as its own column — only the matrix deforms on 24h <-> 7d. */}
      <div {...stylex.props(styles.rangeSpacing)}>
        {/* The frame keeps its height across ranges so the panel below it does
            not jump while a range animates in. */}
        <div
          role="grid"
          aria-label={t('workspace.usage.skyline.heatmap')}
          {...stylex.props(styles.rangeFrame)}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={timeline.range}
              initial={reduced ? false : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            >
              {timeline.range === 'week' ? (
                <UsageWeekMatrix
                  timeline={timeline}
                  metric={metric}
                  intensityOf={intensityOf}
                  reduced={reduced}
                  weekdayFormat={formats.weekday}
                  dayOfMonthFormat={formats.dayOfMonth}
                  selectedCellMs={selectedCellMs}
                  onToggleDay={toggleDay}
                />
              ) : (
                <UsageDayMatrix
                  timeline={timeline}
                  metric={metric}
                  intensityOf={intensityOf}
                  reduced={reduced}
                  selectedCellMs={selectedCellMs}
                  onToggleDay={toggleDay}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Fixed height, single line: the idle hint and the selected-day readout
          trade places without resizing the panel. */}
      <div {...stylex.props(styles.rangeReadout)}>
        <p {...stylex.props(styles.readout)} aria-live="polite">
          {selectedDayMs !== null && selectedDayTotal !== null ? (
            <>
              {formats.day.format(new Date(selectedDayMs))}
              {selectedDayTotal > 0
                ? ` · ${formatMetric(selectedDayTotal, metric)}${
                    metric === 'tokens' ? ` ${t('workspace.usage.tokens')}` : ''
                  }`
                : ` · ${t('workspace.usage.skyline.noUsage')}`}
            </>
          ) : (
            <span {...stylex.props(styles.clickHint)}>
              <MousePointerClick {...stylex.props(styles.iconSmall)} aria-hidden="true" />
              {t('workspace.usage.skyline.clickHint')}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Position only — the cell is resolved at render time so a metric switch cannot
 * stale it. Coordinates are relative to the heatmap root, not the scrolling
 * grid, so the bubble can always sit above a cell without the scroller clipping
 * it (`overflow-x: auto` forces `overflow-y: auto`).
 */
type HeatmapTooltip = { left: number; top: number };

/** A clicked day plus where its caret should sit, in heatmap-root coordinates. */
export type UsageSelectedDay = { dayStartMs: number; anchorX: number };

/** Opacity of a day that sits outside the selected window; it stays as context. */
const OUT_OF_WINDOW_OPACITY = 0.3;

function UsageHeatmap({
  model,
  metric,
  selectedDayMs,
  onSelectDay,
  onMoveDayAnchor,
  windowStartMs,
}: {
  model: UsageCalendarModel;
  metric: UsageCalendarMetric;
  selectedDayMs: number | null;
  onSelectDay: (day: UsageSelectedDay | null) => void;
  onMoveDayAnchor: (day: UsageSelectedDay) => void;
  /**
   * First day of the selected range. Earlier days stay on screen but recede, so
   * 30d and all-time are the same skyline with a different day lit.
   */
  windowStartMs?: number;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const monthLabels = useMonthLabels(model, formats.month);
  const scale = useMemo(() => createUsageHeatScale(model), [model]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const selectedIndex = useMemo(
    () =>
      selectedDayMs === null
        ? -1
        : model.cells.findIndex((cell) => cell.dayStartMs === selectedDayMs),
    [model.cells, selectedDayMs]
  );

  const todayIndex = useMemo(() => {
    let latest = -1;
    for (const [index, cell] of model.cells.entries()) if (!cell.isFuture) latest = index;
    return latest;
  }, [model.cells]);
  // Roving tabindex: the grid is one tab stop, arrow keys walk days and weeks.
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, todayIndex));

  const cellLabel = useCallback(
    (cell: UsageCalendarCell) => {
      const date = formats.day.format(new Date(cell.dayStartMs));
      if (cell.isFuture) return `${date} · ${t('workspace.usage.skyline.future')}`;
      if (cell.value <= 0) return `${date} · ${t('workspace.usage.skyline.noUsage')}`;
      const suffix = metric === 'tokens' ? ` ${t('workspace.usage.tokens')}` : '';
      return `${date} · ${formatMetric(cell.value, metric)}${suffix}`;
    },
    [formats.day, metric, t]
  );

  const showDetail = useCallback(
    (index: number, element: HTMLButtonElement | null) => {
      if (!model.cells[index]) return;
      setDetailIndex(index);
      const root = rootRef.current;
      if (!element || !root) return;
      const cellRect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const center = cellRect.left + cellRect.width / 2 - rootRect.left;
      // Keep the bubble inside the card so the first and last weeks stay readable.
      const margin = Math.min(72, rootRect.width / 2);
      setTooltip({
        left: Math.min(Math.max(center, margin), Math.max(margin, rootRect.width - margin)),
        top: cellRect.top - rootRect.top - 6,
      });
    },
    [model.cells]
  );

  const clearDetail = useCallback(() => {
    setTooltip(null);
    setDetailIndex(null);
  }, []);

  /** Caret x for a cell, in coordinates of the heatmap root the panel shares. */
  const measureAnchorX = useCallback((index: number) => {
    const element = cellRefs.current[index];
    const root = rootRef.current;
    if (!element || !root) return 0;
    const cellRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - rootRect.left;
  }, []);

  const toggleDay = useCallback(
    (index: number) => {
      const cell = model.cells[index];
      // A future day has nothing to expand.
      if (!cell || cell.isFuture) return;
      if (cell.dayStartMs === selectedDayMs) {
        onSelectDay(null);
        return;
      }
      onSelectDay({ dayStartMs: cell.dayStartMs, anchorX: measureAnchorX(index) });
    },
    [measureAnchorX, model.cells, onSelectDay, selectedDayMs]
  );

  // The caret must follow its cell when the calendar scrolls or the panel resizes.
  useEffect(() => {
    if (selectedIndex < 0 || selectedDayMs === null) return undefined;
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    if (!scroller || !root) return undefined;
    const sync = () =>
      onMoveDayAnchor({ dayStartMs: selectedDayMs, anchorX: measureAnchorX(selectedIndex) });
    scroller.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => {
      scroller.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [measureAnchorX, onMoveDayAnchor, selectedDayMs, selectedIndex]);

  const focusCell = useCallback((index: number) => {
    const next = Math.min(Math.max(index, 0), USAGE_CALENDAR_CELLS - 1);
    setFocusIndex(next);
    cellRefs.current[next]?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -USAGE_CALENDAR_ROWS,
      ArrowRight: USAGE_CALENDAR_ROWS,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : Math.max(0, todayIndex));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleDay(index);
    }
  };

  const detailCell = detailIndex === null ? null : model.cells[detailIndex];
  const peakShare = useMemo(() => {
    if (!detailCell || model.maxValue <= 0 || detailCell.value <= 0) return null;
    const percent = (detailCell.value / model.maxValue) * 100;
    // A quiet day next to a launch-day spike must not read as a flat "0%".
    return percent < 1 ? '<1' : String(Math.round(percent));
  }, [detailCell, model.maxValue]);

  return (
    <div ref={rootRef} {...stylex.props(styles.heatmapRoot)}>
      {/* Use the heatmap's real container, not the viewport, to decide whether
          the compact mobile minimum is needed. A desktop settings panel can then
          use every available pixel without manufacturing horizontal overflow. */}
      <div {...stylex.props(styles.heatmapLayout)}>
        <div aria-hidden="true" {...stylex.props(styles.weekdayGutter)}>
          {Array.from({ length: USAGE_CALENDAR_ROWS }, (_, row) => {
            const sample = model.cells[row];
            return (
              <span key={row} {...stylex.props(styles.row)}>
                {row % 2 === 1 && sample ? formats.weekday.format(new Date(sample.dayStartMs)) : ''}
              </span>
            );
          })}
        </div>

        {/* RTL gives an overflowing calendar a native right-edge origin without
            programmatic scrolling, so mounting it does not reveal an overlay
            scrollbar. Restore LTR on the content to preserve chronological order. */}
        <div ref={scrollerRef} dir="rtl" {...stylex.props(styles.scroller)}>
          <div
            dir="ltr"
            {...stylex.props(styles.heatmapContent)}
            style={
              {
                '--usage-heatmap-min-track-width': `${HEATMAP_MIN_TRACK_WIDTH}px`,
              } as CSSProperties
            }
          >
            <div
              {...stylex.props(styles.monthLabels)}
              style={{ gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE }}
            >
              {monthLabels.map(({ column, label }) => (
                <span
                  key={column}
                  {...stylex.props(styles.noWrap)}
                  style={{ gridColumn: `${column + 1} / span ${MIN_COLUMNS_BETWEEN_MONTH_LABELS}` }}
                >
                  {label}
                </span>
              ))}
            </div>

            <div
              role="grid"
              aria-label={t('workspace.usage.skyline.heatmap')}
              {...stylex.props(styles.heatmapGrid)}
              style={{ gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE }}
              onPointerLeave={clearDetail}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  clearDetail();
              }}
            >
              {model.cells.map((cell, index) => {
                const intensity = cell.isFuture ? 0 : scale.intensity(cell.value);
                const outsideWindow =
                  windowStartMs !== undefined && cell.dayStartMs < windowStartMs;
                return (
                  <button
                    key={cell.dayStartMs}
                    ref={(element) => {
                      cellRefs.current[index] = element;
                    }}
                    type="button"
                    role="gridcell"
                    tabIndex={index === focusIndex ? 0 : -1}
                    aria-label={cellLabel(cell)}
                    aria-selected={index === detailIndex}
                    {...stylex.props(
                      styles.heatCell,
                      cell.isFuture ? styles.heatCellFuture : styles.heatCellInteractive,
                      cell.isFuture && styles.staticHeatCell,
                      index === todayIndex && index === selectedIndex
                        ? styles.todaySelectedCell
                        : index === todayIndex
                          ? styles.todayCell
                          : index === selectedIndex && styles.selectedCell
                    )}
                    style={{
                      backgroundColor: cell.isFuture
                        ? FUTURE_DAY_COLOR
                        : intensity > 0
                          ? heatColor(intensity)
                          : EMPTY_DAY_COLOR,
                      opacity: outsideWindow ? OUT_OF_WINDOW_OPACITY : 1,
                      animationDelay: `${cell.column * CELL_REVEAL_STAGGER_MS}ms`,
                    }}
                    onClick={() => toggleDay(index)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    onFocus={(event) => {
                      setFocusIndex(index);
                      showDetail(index, event.currentTarget);
                    }}
                    onPointerEnter={(event) => showDetail(index, event.currentTarget)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {tooltip && detailCell ? (
        <div
          aria-hidden="true"
          {...stylex.props(styles.tooltip)}
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <span {...stylex.props(styles.tooltipStrong)}>
            {detailCell.isFuture
              ? t('workspace.usage.skyline.future')
              : detailCell.value > 0
                ? formatMetric(detailCell.value, metric)
                : t('workspace.usage.skyline.noUsage')}
          </span>
          <span {...stylex.props(styles.tooltipMuted)}>
            {formats.day.format(new Date(detailCell.dayStartMs))}
          </span>
          {!detailCell.isFuture && detailCell.dayStartMs !== selectedDayMs ? (
            <span {...stylex.props(styles.tooltipHint)}>
              {t('workspace.usage.skyline.clickForDetails')}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Fixed height, single line, no wrapping: the idle hint carries an icon and
          the selected-day readout does not, and either can be long enough to wrap.
          Without this the row grew and shrank as the pointer moved. */}
      <div {...stylex.props(styles.fixedReadout)}>
        <p {...stylex.props(styles.readout)} aria-live="polite">
          {detailCell ? (
            <>
              {cellLabel(detailCell)}
              {peakShare !== null ? (
                <span {...stylex.props(styles.peakShare)}>
                  {` · ${t('workspace.usage.skyline.peakShare', { percent: peakShare })}`}
                </span>
              ) : null}
            </>
          ) : (
            <span {...stylex.props(styles.clickHint)}>
              <MousePointerClick {...stylex.props(styles.iconSmall)} aria-hidden="true" />
              {t('workspace.usage.skyline.clickHint')}
            </span>
          )}
        </p>
        <HeatLegend />
      </div>
    </div>
  );
}

/**
 * Bar fills are a light tint of the chart blue rather than solid blue: a panel
 * with eight bars reads as a wall of colour otherwise. The label sits on top in
 * the foreground colour, so contrast never depends on the fill.
 */
const RANK_FILL_ALPHAS = [0.42, 0.33, 0.26, 0.2, 0.15] as const;
const rankFill = (rank: number) =>
  heatColor(RANK_FILL_ALPHAS[Math.min(rank, RANK_FILL_ALPHAS.length - 1)]!);
/** The composition rule is small, so it can carry more weight than the bars. */
const COMPOSITION_ALPHAS = [0.75, 0.55, 0.38, 0.24] as const;
const compositionFill = (index: number) =>
  heatColor(COMPOSITION_ALPHAS[index % COMPOSITION_ALPHAS.length]!);

/** Longest model/member list the panel shows before folding the rest into "other". */
const DAY_DETAIL_ROW_LIMIT = 5;

type BreakdownRow = { id: string; label: string; tokens: number; icon?: ReactNode };

function RankedBars({ rows }: { rows: BreakdownRow[] }) {
  const { t } = useTranslation();
  const visible = rows.slice(0, DAY_DETAIL_ROW_LIMIT);
  const max = visible.reduce((peak, row) => Math.max(peak, row.tokens), 0);
  const restTokens = rows
    .slice(DAY_DETAIL_ROW_LIMIT)
    .reduce((sum, row) => sum + Math.max(0, row.tokens), 0);

  return (
    <ul {...stylex.props(styles.rankedRows)}>
      {visible.map((row, rank) => (
        <li key={row.id} {...stylex.props(styles.rankedRow)}>
          <span
            aria-hidden="true"
            {...stylex.props(styles.rankedFill)}
            style={{
              width: `${max > 0 ? Math.max(3, (row.tokens / max) * 100) : 0}%`,
              backgroundColor: rankFill(rank),
            }}
          />
          <span {...stylex.props(styles.rankedContent)}>
            {row.icon}
            <span {...stylex.props(styles.rankedName)}>{row.label}</span>
            <span {...stylex.props(styles.rankedValue)}>{formatTokens(row.tokens)}</span>
          </span>
        </li>
      ))}
      {restTokens > 0 ? (
        <li {...stylex.props(styles.rankedRest)}>
          {t('workspace.usage.skyline.otherRows', {
            count: rows.length - DAY_DETAIL_ROW_LIMIT,
            tokens: formatTokens(restTokens),
          })}
        </li>
      ) : null}
    </ul>
  );
}

function UsageDayDetailPanel({
  dayStartMs,
  anchorX,
  detail,
  loading,
  onClose,
}: {
  dayStartMs: number;
  anchorX: number;
  detail: SettingsUsageDayData | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const { locale } = formats;
  // While a new day is in flight the previous payload is still mounted; only
  // render numbers once they belong to the day the user actually clicked.
  const day = detail?.dayStartMs === dayStartMs ? detail : undefined;

  const composition = day
    ? [
        {
          key: 'cache',
          label: t('workspace.usage.breakdown.cache'),
          value: day.totals.cacheReadInputTokens + day.totals.cacheCreationInputTokens,
        },
        {
          key: 'input',
          label: t('workspace.usage.breakdown.input'),
          value: day.totals.inputTokens,
        },
        {
          key: 'output',
          label: t('workspace.usage.breakdown.output'),
          value: day.totals.outputTokens,
        },
        {
          key: 'reasoning',
          label: t('workspace.usage.breakdown.reasoning'),
          value: day.totals.reasoningOutputTokens,
        },
      ]
        .filter((segment) => segment.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  const compositionTotal = composition.reduce((sum, segment) => sum + segment.value, 0);
  const hasUsage = Boolean(day && day.totals.tokens > 0);

  return (
    <div {...stylex.props(styles.detailPointer)}>
      <span aria-hidden="true" {...stylex.props(styles.caret)} style={{ left: anchorX }} />
      <section
        aria-label={t('workspace.usage.skyline.dayDetail')}
        {...stylex.props(styles.detailPanel)}
      >
        <Button
          icon
          variant="ghost"
          aria-label={t('common.close')}
          className="absolute right-2 top-2 h-6 w-6 text-muted-foreground"
          onClick={onClose}
        >
          <X {...stylex.props(styles.detailCloseIcon)} />
        </Button>
        <div {...stylex.props(styles.detailGrid)}>
          <div {...stylex.props(styles.minWidthZero)}>
            <p {...stylex.props(styles.detailDate)}>{formats.day.format(new Date(dayStartMs))}</p>
            <p {...stylex.props(styles.detailTotal)}>
              <span {...stylex.props(styles.detailValue)}>
                {day ? (
                  <NumberFlow
                    value={day.totals.tokens}
                    locales={locale}
                    format={{ notation: 'compact', maximumFractionDigits: 1 }}
                  />
                ) : (
                  '—'
                )}
              </span>
              <span {...stylex.props(styles.detailUnits)}>{t('workspace.usage.tokens')}</span>
            </p>
            <p {...stylex.props(styles.detailCost)}>
              {day
                ? [
                    formatCost(day.totals.costUSD, locale),
                    day.totals.webSearchRequests > 0
                      ? t('workspace.usage.skyline.webSearches', {
                          count: day.totals.webSearchRequests,
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : ''}
            </p>

            {hasUsage ? (
              <>
                <div aria-hidden="true" {...stylex.props(styles.detailComposition)}>
                  {composition.map((segment, index) => (
                    <span
                      key={segment.key}
                      style={{
                        width: `${(segment.value / compositionTotal) * 100}%`,
                        backgroundColor: compositionFill(index),
                      }}
                    />
                  ))}
                </div>
                <ul {...stylex.props(styles.detailLegend)}>
                  {composition.map((segment, index) => (
                    <li key={segment.key} {...stylex.props(styles.detailItem)}>
                      <span
                        aria-hidden="true"
                        {...stylex.props(styles.detailColorDot)}
                        style={{ backgroundColor: compositionFill(index) }}
                      />
                      <span {...stylex.props(styles.truncatedLabel)}>{segment.label}</span>
                      <span {...stylex.props(styles.detailPercent)}>
                        {formatTokens(segment.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {!day && loading ? (
              <div {...stylex.props(styles.loadingRows)} aria-busy="true">
                <div {...stylex.props(styles.loadingLine)} />
                <div {...stylex.props(styles.loadingLineShort)} />
              </div>
            ) : null}
            {day && !hasUsage ? (
              <p {...stylex.props(styles.noUsage)}>{t('workspace.usage.skyline.noUsage')}</p>
            ) : null}
          </div>

          {hasUsage && day ? (
            <div {...stylex.props(styles.twoColumns)}>
              <div {...stylex.props(styles.minWidthZero)}>
                <p {...stylex.props(styles.detailSectionLabel)}>{t('workspace.usage.byModel')}</p>
                <RankedBars
                  rows={day.byModel.map((row) => ({
                    id: row.modelId,
                    label: row.modelId,
                    tokens: row.tokens,
                    icon: (
                      <ModelBrandIcon
                        modelId={row.modelId}
                        className={stylex.props(styles.iconMuted).className}
                      />
                    ),
                  }))}
                />
              </div>
              <div {...stylex.props(styles.minWidthZero)}>
                <p {...stylex.props(styles.detailSectionLabel)}>{t('workspace.usage.byUser')}</p>
                <RankedBars
                  rows={day.byUser.map((row) => {
                    const user = day.users[row.userId];
                    const label = user?.name || user?.email || row.userId;
                    return {
                      id: row.userId,
                      label,
                      tokens: row.tokens,
                      icon: (
                        <Avatar.Root size="mini">
                          {user?.image ? <Avatar.Image src={user.image} alt="" /> : null}
                          <Avatar.Fallback>{label.slice(0, 2).toUpperCase()}</Avatar.Fallback>
                        </Avatar.Root>
                      ),
                    };
                  })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function FitCamera({
  width,
  depth,
  height,
  centerX = 0,
  padding = 1,
  framing = 1,
  front = false,
}: {
  width: number;
  depth: number;
  height: number;
  centerX?: number;
  padding?: number;
  framing?: number;
  front?: boolean;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const orthographic = camera as THREE.OrthographicCamera;
    const aspect = Math.max(0.5, size.width / Math.max(1, size.height));
    // Account for both horizontal and vertical spans of the isometric projection.
    // The previous width-only calculation cropped the far edge on wide canvases.
    const horizontalSpan = (width + depth) * 0.78;
    const verticalSpan = (width + depth) * 0.52 + height;
    const fittedFrustumHeight = Math.max(
      17,
      verticalSpan * padding,
      (horizontalSpan * padding) / aspect
    );
    const frustumHeight = fittedFrustumHeight * framing;
    const cameraDistance = Math.max(width, depth) * 0.88;
    orthographic.zoom = 1;
    orthographic.left = (-frustumHeight * aspect) / 2;
    orthographic.right = (frustumHeight * aspect) / 2;
    orthographic.top = frustumHeight / 2;
    orthographic.bottom = -frustumHeight / 2;
    orthographic.position.set(
      centerX + (front ? cameraDistance * 0.45 : cameraDistance),
      cameraDistance * 0.72 + height,
      front ? -cameraDistance : cameraDistance
    );
    orthographic.lookAt(centerX, height * 0.16, 0);
    orthographic.updateProjectionMatrix();
  }, [camera, centerX, depth, framing, front, height, padding, size.height, size.width, width]);
  return null;
}

function SceneOrbitControls({ targetY }: { targetY: number }) {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);

  useEffect(() => {
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minZoom = 0.65;
    controls.maxZoom = 3.2;
    controls.target.set(0, targetY, 0);
    controls.update();
    return () => controls.dispose();
  }, [controls, targetY]);

  useFrame(() => controls.update());
  return null;
}

function SummaryStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div {...stylex.props(styles.minWidthZero)}>
      <dt {...stylex.props(styles.statLabel)}>{label}</dt>
      <dd {...stylex.props(styles.statValue)}>{value}</dd>
      {detail ? <p {...stylex.props(styles.statDetail)}>{detail}</p> : null}
    </div>
  );
}

function UsageSummary({
  model,
  metric,
}: {
  model: UsageCalendarModel;
  metric: UsageCalendarMetric;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const completedCells = useMemo(() => model.cells.filter((cell) => !cell.isFuture), [model.cells]);
  const peakCell = useMemo(
    () =>
      completedCells.reduce<UsageCalendarCell | null>(
        (peak, cell) => (!peak || cell.value > peak.value ? cell : peak),
        null
      ),
    [completedCells]
  );
  const dailyAverage = completedCells.length > 0 ? model.totalValue / completedCells.length : 0;
  const peakDate =
    peakCell && peakCell.value > 0
      ? formats.day.format(new Date(peakCell.dayStartMs))
      : t('workspace.usage.skyline.noUsage');

  return (
    <dl {...stylex.props(styles.summaryStats)}>
      <SummaryStat
        label={t('workspace.usage.skyline.total')}
        value={formatMetric(model.totalValue, metric)}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.dailyAverage')}
        value={formatMetric(dailyAverage, metric)}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.peakDay')}
        value={formatMetric(peakCell?.value ?? 0, metric)}
        detail={peakDate}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.activeDays')}
        value={String(model.activeDays)}
        detail={t('workspace.usage.skyline.currentStreakDetail', { days: model.currentStreak })}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.longestStreak')}
        value={String(model.longestStreak)}
      />
    </dl>
  );
}

function UsageTimelineSummary({
  timeline,
  metric,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
}) {
  const { t } = useTranslation();
  const values = timeline.buckets.map((bucket) =>
    metric === 'tokens' ? bucket.tokens : bucket.costUSD
  );
  const active = values.filter((value) => value > 0);
  const peakIndex = values.reduce(
    (peak, value, index) => (value > (values[peak] ?? 0) ? index : peak),
    0
  );
  let currentStreak = 0;
  for (let index = values.length - 1; index >= 0 && values[index]! > 0; index -= 1) {
    currentStreak += 1;
  }
  let longestStreak = 0;
  let streak = 0;
  for (const value of values) {
    streak = value > 0 ? streak + 1 : 0;
    longestStreak = Math.max(longestStreak, streak);
  }
  const peakBucket = timeline.buckets[peakIndex];

  return (
    <dl {...stylex.props(styles.summaryStats)}>
      <SummaryStat
        label={t('workspace.usage.skyline.total')}
        value={formatMetric(
          metric === 'tokens' ? timeline.totals.tokens : timeline.totals.costUSD,
          metric
        )}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.averagePerInterval')}
        value={formatMetric(
          values.length > 0
            ? (metric === 'tokens' ? timeline.totals.tokens : timeline.totals.costUSD) /
                values.length
            : 0,
          metric
        )}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.peakInterval')}
        value={formatMetric(values[peakIndex] ?? 0, metric)}
        detail={
          peakBucket
            ? formatUsageTimelineBucketLabel(
                timeline,
                peakBucket,
                createUsageTimelineFormatter(usageIntlLocale())
              )
            : t('workspace.usage.skyline.noUsage')
        }
      />
      <SummaryStat
        label={t('workspace.usage.skyline.activeIntervals')}
        value={String(active.length)}
        detail={t('workspace.usage.skyline.currentIntervalStreakDetail', { count: currentStreak })}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.longestStreak')}
        value={String(longestStreak)}
      />
    </dl>
  );
}

function StlMetalColumns({ model }: { model: UsageCalendarModel }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const activeCells = useMemo(
    () => model.cells.filter((cell) => !cell.isFuture && cell.value > 0),
    [model.cells]
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.count = activeCells.length;
    for (const [index, cell] of activeCells.entries()) {
      const height =
        getUsageColumnHeight(cell.value, model.maxValue, 'skyline') *
        USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER;
      dummy.position.set(
        USAGE_SKYLINE_STL_BASE_WIDTH / 2 -
          (USAGE_SKYLINE_STL_CELL_SIZE +
            cell.column * USAGE_SKYLINE_STL_CELL_SIZE +
            USAGE_SKYLINE_STL_CELL_SIZE / 2),
        height / 2,
        USAGE_SKYLINE_STL_BACK_MARGIN +
          cell.row * USAGE_SKYLINE_STL_CELL_SIZE +
          USAGE_SKYLINE_STL_CELL_SIZE / 2 -
          USAGE_SKYLINE_STL_BASE_DEPTH / 2
      );
      dummy.scale.set(USAGE_SKYLINE_STL_CELL_SIZE, height, USAGE_SKYLINE_STL_CELL_SIZE);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [activeCells, dummy, model.maxValue]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, Math.max(1, activeCells.length)]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#c8d1d9" metalness={0.72} roughness={0.23} />
    </instancedMesh>
  );
}

function StlLodyLogoRelief() {
  const geometry = useMemo(() => {
    const triangles = createUsageSkylineLodyLogoTriangles();
    // The STL keeps a closed back face for printing, but it lies exactly on the base face.
    // Excluding it from the preview prevents depth-buffer flicker while orbiting the model.
    const visualTriangles = triangles.filter(
      (triangle) => ![triangle.a, triangle.b, triangle.c].every(([, y]) => y === 0)
    );
    const positions = new Float32Array(visualTriangles.length * 9);
    let offset = 0;
    for (const triangle of visualTriangles) {
      for (const [x, y, z] of [triangle.a, triangle.c, triangle.b]) {
        positions[offset++] = USAGE_SKYLINE_STL_BASE_WIDTH / 2 - x;
        positions[offset++] = z;
        positions[offset++] = y - USAGE_SKYLINE_STL_BASE_DEPTH / 2;
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    result.computeVertexNormals();
    return result;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#e8eef2" metalness={0.84} roughness={0.24} />
    </mesh>
  );
}

function StlMetalView({ model }: { model: UsageCalendarModel }) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t('workspace.usage.skyline.stlMetalPreview')}
      {...stylex.props(styles.skylinePreview)}
    >
      <Canvas
        orthographic
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        {...stylex.props(styles.canvas)}
      >
        <ambientLight intensity={1.15} />
        <hemisphereLight args={['#d6e8ff', '#27303a', 1.5]} />
        <directionalLight position={[80, 110, 65]} intensity={4.2} color="#f5f7fa" />
        <directionalLight position={[-60, 38, 48]} intensity={3.1} color="#86b8ff" />
        <directionalLight position={[24, 18, -72]} intensity={2.1} color="#f3c68b" />
        <FitCamera
          width={USAGE_SKYLINE_STL_BASE_WIDTH}
          depth={USAGE_SKYLINE_STL_BASE_DEPTH}
          height={30}
          padding={1.2}
          front
        />
        <SceneOrbitControls targetY={4} />
        <mesh position={[0, -USAGE_SKYLINE_STL_BASE_HEIGHT / 2, 0]}>
          <boxGeometry
            args={[
              USAGE_SKYLINE_STL_BASE_WIDTH,
              USAGE_SKYLINE_STL_BASE_HEIGHT,
              USAGE_SKYLINE_STL_BASE_DEPTH,
            ]}
          />
          <meshStandardMaterial color="#68737d" metalness={0.78} roughness={0.3} />
        </mesh>
        <StlLodyLogoRelief />
        <StlMetalColumns model={model} />
      </Canvas>
    </div>
  );
}

function SkylineAscii({ content }: { content: string }) {
  return <pre {...stylex.props(styles.ascii)}>{content}</pre>;
}

export function UsageCalendarVisualization({
  calendar,
  timeline,
  workspaceName,
  dayDetail,
  dayDetailLoading = false,
  onSelectedDayChange,
}: {
  calendar: SettingsUsageCalendarData;
  /** Selected-range timeline used for the compact skyline and 100% composition rings. */
  timeline?: SettingsUsageTimelineData;
  workspaceName?: string;
  /** Breakdown for the currently selected day; the container owns the query. */
  dayDetail?: SettingsUsageDayData;
  dayDetailLoading?: boolean;
  onSelectedDayChange?: (dayStartMs: number | null) => void;
}) {
  const { t } = useTranslation();
  const [selectedDay, setSelectedDay] = useState<UsageSelectedDay | null>(null);
  // Kept so the panel still has content to render while it collapses.
  const [collapsingDay, setCollapsingDay] = useState<UsageSelectedDay | null>(null);
  const notifiedDayRef = useRef<number | null>(null);
  const [metric, setMetric] = useState<UsageCalendarMetric>('tokens');
  // Exports are always token-denominated; only the on-screen views follow the
  // metric toggle.
  const tokenModel = useMemo(() => createUsageCalendarModel(calendar, 'tokens'), [calendar]);
  const costModel = useMemo(() => createUsageCalendarModel(calendar, 'costUSD'), [calendar]);
  const model = metric === 'tokens' ? tokenModel : costModel;
  const reduced = useReducedMotion() ?? false;
  /**
   * 24h and 7d get the hourly range panel. 30d is the widest range and stays on
   * the year skyline with its window lit, so 30d and all-time are one view.
   */
  const hourlyTimeline =
    timeline && (timeline.range === 'day' || timeline.range === 'week') ? timeline : null;
  const windowTimeline = timeline && timeline.range === 'month' ? timeline : null;
  const rings = useUsageRingComposition(hourlyTimeline ?? undefined);
  const ascii = useMemo(() => createUsageSkylineAscii(tokenModel), [tokenModel]);
  const stem = fileStem(workspaceName || 'lody-usage');

  const selectDay = useCallback(
    (day: UsageSelectedDay | null) => {
      setSelectedDay(day);
      if (day) setCollapsingDay(day);
      const nextDayStartMs = day?.dayStartMs ?? null;
      if (notifiedDayRef.current === nextDayStartMs) return;
      notifiedDayRef.current = nextDayStartMs;
      onSelectedDayChange?.(nextDayStartMs);
    },
    [onSelectedDayChange]
  );

  // Exiting views can still measure their old cell. Position sync must never
  // reopen a cleared day or replace a newer selection.
  const moveDayAnchor = useCallback((day: UsageSelectedDay) => {
    if (notifiedDayRef.current !== day.dayStartMs) return;
    setSelectedDay(day);
    setCollapsingDay(day);
  }, []);

  // The hourly matrices remount on every range switch, which strands the caret
  // anchor — a selection only survives 30d <-> all-time, where the heatmap
  // re-measures its own cell.
  const hourlyRange = hourlyTimeline?.range ?? null;
  const previousHourlyRangeRef = useRef(hourlyRange);
  useEffect(() => {
    if (previousHourlyRangeRef.current === hourlyRange) return;
    previousHourlyRangeRef.current = hourlyRange;
    if (selectedDay) selectDay(null);
  }, [hourlyRange, selectDay, selectedDay]);

  const copyAscii = async () => {
    try {
      await navigator.clipboard.writeText(ascii);
      toast.success(t('workspace.usage.skyline.asciiCopied'));
    } catch {
      toast.error(t('workspace.usage.skyline.copyFailed'));
    }
  };

  const exportAscii = () => {
    downloadBlob(
      new Blob([ascii], { type: 'text/plain;charset=utf-8' }),
      `${stem}-usage-skyline.txt`
    );
  };

  const exportStl = () => {
    downloadBlob(
      new Blob([createUsageSkylineBinaryStl(tokenModel)], { type: 'model/stl' }),
      `${stem}-usage-skyline.stl`
    );
  };

  return (
    <section {...stylex.props(styles.card)}>
      <header {...stylex.props(styles.cardHeader)}>
        <div {...stylex.props(styles.minWidthZero)}>
          <h3 {...stylex.props(styles.cardTitle)}>{t('workspace.usage.skyline.title')}</h3>
          <p {...stylex.props(styles.cardSubtitle)}>
            {hourlyTimeline
              ? t(`workspace.usage.window.${hourlyTimeline.range}.long`)
              : windowTimeline
                ? t('workspace.usage.skyline.windowSubtitle')
                : t('workspace.usage.skyline.subtitle')}
          </p>
        </div>
        <div {...stylex.props(styles.controlGroup)}>
          <SegmentedControl
            label={t('workspace.usage.skyline.metric')}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'tokens', label: t('workspace.usage.tokens') },
              { value: 'costUSD', label: t('workspace.usage.cost') },
            ]}
          />
        </div>
      </header>

      <div {...stylex.props(styles.cardBody)}>
        {/* The donut ring is hourly-only chrome with its own fade; it never
            joins the blur cross-fade of the matrix/heatmap container, it only
            re-slices itself when the range's composition changes. One key for
            both skyline ranges: 30d and all-time never unmount each other, so
            widening the window only relights days in place. The hourly panel is
            a different object — popLayout cross-fades the swap instead of
            letting the old view vanish before the new one starts. */}
        <div {...stylex.props(styles.minWidthZero, rings && styles.ringLayout)}>
          {/* Hourly ranges only: the ring runs its own plain fade, independent
              of the matrix container's blur cross-fade. popLayout pops the
              leaving ring out of flow at its old spot — otherwise the grid
              collapses to one column first and the exiting ring reflows to
              full width for a frame before fading out. */}
          <AnimatePresence mode="popLayout" initial={false}>
            {rings && hourlyTimeline ? (
              <motion.div
                key="rings"
                {...stylex.props(styles.minWidthZero)}
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.15, ease: 'easeOut' }}
              >
                <UsageTokenRings
                  segments={rings.segments}
                  caption={rings.caption}
                  total={
                    metric === 'tokens'
                      ? hourlyTimeline.totals.tokens
                      : hourlyTimeline.totals.costUSD
                  }
                  totalLabel={
                    metric === 'tokens' ? t('workspace.usage.tokens') : t('workspace.usage.cost')
                  }
                  metric={metric}
                  reduced={reduced}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={hourlyTimeline ? 'hourly' : 'skyline'}
              {...stylex.props(styles.fullWidth)}
              initial={reduced ? false : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            >
              {hourlyTimeline ? (
                <UsageRangePanel
                  timeline={hourlyTimeline}
                  metric={metric}
                  selectedDayMs={selectedDay?.dayStartMs ?? null}
                  onSelectDay={selectDay}
                  onMoveDayAnchor={moveDayAnchor}
                />
              ) : (
                <UsageHeatmap
                  model={model}
                  metric={metric}
                  selectedDayMs={selectedDay?.dayStartMs ?? null}
                  onSelectDay={selectDay}
                  onMoveDayAnchor={moveDayAnchor}
                  windowStartMs={windowTimeline?.startMs}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Expanding a row height needs a definite value; the 0fr -> 1fr grid
            track does it without measuring the panel. The bezier approximates a
            soft spring — fast start, slight overshoot, gentle settle. */}
        <div
          {...stylex.props(styles.expandingPanel, selectedDay ? styles.expanded : styles.collapsed)}
          onTransitionEnd={() => {
            if (!selectedDay) setCollapsingDay(null);
          }}
        >
          <div {...stylex.props(styles.hiddenOverflow)}>
            {collapsingDay ? (
              <UsageDayDetailPanel
                dayStartMs={collapsingDay.dayStartMs}
                anchorX={collapsingDay.anchorX}
                detail={dayDetail}
                loading={dayDetailLoading}
                onClose={() => selectDay(null)}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Metrics band: the by-model / by-member composition rules sit above the
          range stats for whichever range is on screen. */}
      <div {...stylex.props(styles.metricBand)}>
        {timeline ? <UsageCompositionSummary timeline={timeline} reduced={reduced} /> : null}
        {timeline ? (
          timeline.range === 'total' ? (
            <UsageSummary model={model} metric={metric} />
          ) : (
            <UsageTimelineSummary timeline={timeline} metric={metric} />
          )
        ) : (
          <UsageSummary model={model} metric={metric} />
        )}
      </div>

      <div {...stylex.props(styles.lowerBlock)}>
        {SHOW_SKYLINE_EXPORTS ? (
          <>
            <StlMetalView model={tokenModel} />
            <div {...stylex.props(styles.exportRow)}>
              <div {...stylex.props(styles.exportLabel)}>
                <FileText {...stylex.props(styles.iconMedium)} />
                <span>{t('workspace.usage.skyline.asciiPreview')}</span>
              </div>
              <div {...stylex.props(styles.exportActions)}>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Button
                        icon
                        variant="ghost"
                        onClick={() => void copyAscii()}
                        aria-label={t('workspace.usage.skyline.copyAscii')}
                      >
                        <Copy />
                      </Button>
                    }
                  />
                  <Tooltip.Content>{t('workspace.usage.skyline.copyAscii')}</Tooltip.Content>
                </Tooltip.Root>
                <Button size="small" variant="secondary" onClick={exportAscii}>
                  <Download {...stylex.props(styles.iconMedium)} />
                  {t('workspace.usage.skyline.downloadAscii')}
                </Button>
                <Button size="small" onClick={exportStl}>
                  <Box {...stylex.props(styles.iconMedium)} />
                  {t('workspace.usage.skyline.downloadBinaryStl')}
                </Button>
              </div>
            </div>
            <SkylineAscii content={ascii} />
          </>
        ) : null}
      </div>
    </section>
  );
}
