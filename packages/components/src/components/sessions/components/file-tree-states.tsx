import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
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

export function FileTreeSkeleton({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('p-1', className)}
    >
      <span className="sr-only">Loading files…</span>
      {SKELETON_ROWS.map((row, index) => (
        <div
          key={index}
          className="flex h-[22px] items-center"
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
  return (
    <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full',
          tone === 'error' ? 'bg-destructive/10' : 'bg-muted'
        )}
      >
        <Icon
          className={cn('h-5 w-5', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-[240px] text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
