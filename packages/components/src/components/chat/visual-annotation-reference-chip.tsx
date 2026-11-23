'use client';

import { useState } from 'react';
import { MousePointer2, X } from 'lucide-react';
import type { VisualAnnotationReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { cn } from '@/lib/utils';

export interface VisualAnnotationReferenceChipItem {
  localId: string;
  reference: VisualAnnotationReferencePayload;
}

type VisualAnnotationReferenceChipProps = {
  item: VisualAnnotationReferenceChipItem;
  onRemove?: (localId: string) => void;
  revealRemoveOnClick?: boolean;
  className?: string;
};

const getPageLabel = (reference: VisualAnnotationReferencePayload): string => {
  const pathname = reference.anchor.page.pathname.trim();
  return pathname || reference.anchor.page.url;
};

export function VisualAnnotationReferenceChip({
  item,
  onRemove,
  revealRemoveOnClick = false,
  className,
}: VisualAnnotationReferenceChipProps) {
  const { reference } = item;
  const preview = truncateCommentBody(reference.body, 40);
  const target = reference.anchor.target;
  const [removeVisible, setRemoveVisible] = useState(false);
  const isInteractive = Boolean(revealRemoveOnClick && onRemove);

  return (
    <div
      data-visual-annotation-ref
      className={cn(
        'group/chip relative flex max-w-64 flex-col gap-0.5 rounded-lg border',
        'bg-muted/50 px-2.5 py-1.5 text-xs',
        isInteractive && 'cursor-pointer hover:bg-hover transition-colors',
        className
      )}
      onClick={
        isInteractive
          ? () => {
              setRemoveVisible(true);
            }
          : undefined
      }
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <MousePointer2 className="h-3 w-3 shrink-0" />
        <span className="truncate font-medium">
          {getPageLabel(reference)} · {target.tag.toLowerCase()}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(item.localId);
            }}
            className={cn(
              'ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-xs',
              'text-muted-foreground/60 hover:bg-muted-foreground/20 hover:text-muted-foreground',
              'transition-opacity',
              removeVisible
                ? 'pointer-events-auto opacity-100'
                : 'pointer-events-none opacity-0 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100'
            )}
            aria-label="Remove visual annotation reference"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div className="truncate text-foreground/70">&ldquo;{preview}&rdquo;</div>
      <div className="truncate font-mono text-[10px] text-muted-foreground">{target.selector}</div>
    </div>
  );
}
