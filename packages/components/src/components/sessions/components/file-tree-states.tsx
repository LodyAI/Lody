import type { ComponentType, ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { themeColors } from '../../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../../style/theme-scale.stylex';
import { Skeleton } from '@lody/ui/skeleton';

// Skeleton rows mirror the real file-tree layout: 22px row height, 8px indent
// per level, a 16px icon slot, then a filename bar. A fixed, deterministic shape
// reads as a believable tree and stays visually stable across renders (no
// per-render jitter from random widths, which looks noisy on a pulse animation).
const SKELETON_ROWS: ReadonlyArray<{ level: number; width: number }> = [
  { level: 0, width: 96 },
  { level: 0, width: 64 },
  { level: 1, width: 108 },
  { level: 1, width: 72 },
  { level: 1, width: 88 },
  { level: 2, width: 76 },
  { level: 0, width: 120 },
  { level: 1, width: 64 },
  { level: 1, width: 100 },
  { level: 0, width: 56 },
  { level: 0, width: 84 },
  { level: 1, width: 112 },
  { level: 1, width: 68 },
  { level: 2, width: 92 },
  { level: 2, width: 60 },
  { level: 1, width: 80 },
  { level: 0, width: 104 },
  { level: 0, width: 72 },
  { level: 1, width: 88 },
  { level: 1, width: 116 },
  { level: 0, width: 60 },
  { level: 0, width: 96 },
];

const TREE_INDENT_PX = 8;
const ROW_BASE_PADDING_PX = 8;

const styles = stylex.create({
  skeletonRoot: { padding: themeSpace[1] },
  skeletonRow: { display: 'flex', height: '22px', alignItems: 'center' },
  visuallyHidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  panel: {
    display: 'flex',
    height: '100%',
    minHeight: '160px',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[6],
    paddingBlock: themeSpace[8],
    textAlign: 'center',
  },
  iconWell: {
    display: 'flex',
    height: themeSpace[11],
    width: themeSpace[11],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
  },
  iconWellError: { backgroundColor: 'hsl(var(--destructive) / 0.1)' },
  iconWellNeutral: { backgroundColor: themeColors.muted },
  icon: { height: themeSpace[5], width: themeSpace[5] },
  iconError: { color: themeColors.destructive },
  iconNeutral: { color: themeColors.mutedForeground },
  title: {
    fontSize: '1em',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  /* The stack's gap: Tailwind's `space-y-1` put the space under the title,
     which is the only child before the description. */
  titleGap: { marginBottom: themeSpace[1] },
  description: {
    marginInline: 'auto',
    maxWidth: '240px',
    fontSize: '0.8em',
    lineHeight: '1.25rem',
    color: themeColors.mutedForeground,
  },
  action: { paddingTop: themeSpace[1] },
});

export function FileTreeSkeleton({ className }: { className?: string }) {
  const rootProps = stylex.props(styles.skeletonRoot);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      {...rootProps}
      className={clsx(rootProps.className, className)}
    >
      <span {...stylex.props(styles.visuallyHidden)}>Loading files…</span>
      {SKELETON_ROWS.map((row, index) => (
        <div
          key={index}
          {...stylex.props(styles.skeletonRow)}
          style={{ paddingLeft: row.level * TREE_INDENT_PX + ROW_BASE_PADDING_PX }}
        >
          <Skeleton width={16} height={16} className="mr-1.5 shrink-0" />
          <Skeleton width={row.width} height={10} />
        </div>
      ))}
    </div>
  );
}

export type FileTreeStateTone = 'neutral' | 'error';

export function FileTreeStatePanel({
  icon: Icon,
  title,
  description,
  tone = 'neutral',
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  tone?: FileTreeStateTone;
  action?: ReactNode;
}) {
  const iconProps = stylex.props(
    styles.icon,
    tone === 'error' ? styles.iconError : styles.iconNeutral
  );
  return (
    <div {...stylex.props(styles.panel)}>
      <div
        {...stylex.props(
          styles.iconWell,
          tone === 'error' ? styles.iconWellError : styles.iconWellNeutral
        )}
      >
        <Icon className={iconProps.className} />
      </div>
      <div>
        <p {...stylex.props(styles.title, description ? styles.titleGap : undefined)}>{title}</p>
        {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      </div>
      {action ? <div {...stylex.props(styles.action)}>{action}</div> : null}
    </div>
  );
}
