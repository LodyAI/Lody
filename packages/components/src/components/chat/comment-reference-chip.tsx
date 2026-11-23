'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import type { CommentReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/icons/file-icons';

export interface CommentReferenceChipItem {
  /** Stable local ID for key / removal */
  localId: string;
  /** The comment reference payload */
  reference: CommentReferencePayload;
}

interface CommentReferenceChipProps {
  item: CommentReferenceChipItem;
  onRemove?: (localId: string) => void;
  onClick?: (reference: CommentReferencePayload) => void;
  revealRemoveOnClick?: boolean;
  className?: string;
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

export function CommentReferenceChip({
  item,
  onRemove,
  onClick,
  revealRemoveOnClick = false,
  className,
}: CommentReferenceChipProps) {
  const { reference } = item;
  const fileName = getFileNameFromPath(reference.path);
  const preview = truncateCommentBody(reference.commentBody, 40);
  const [removeVisible, setRemoveVisible] = useState(false);
  const isInteractive = Boolean(onClick || (revealRemoveOnClick && onRemove));

  const handleChipClick = () => {
    if (revealRemoveOnClick && onRemove && !removeVisible) {
      setRemoveVisible(true);
      return;
    }
    setRemoveVisible(false);
    onClick?.(reference);
  };

  return (
    <div
      data-comment-ref
      className={cn(
        'group/chip relative flex max-w-64 flex-col gap-0.5 rounded-lg border',
        'bg-muted/50 px-2.5 py-1.5 text-xs',
        isInteractive && 'cursor-pointer hover:bg-hover transition-colors',
        className
      )}
      onClick={isInteractive ? handleChipClick : undefined}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <FileIcon filePath={reference.path} className="h-3 w-3 shrink-0" />
        <span className="truncate font-medium">
          {fileName}:{reference.lineNumber}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
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
            aria-label="Remove comment reference"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="truncate text-foreground/70">&ldquo;{preview}&rdquo;</div>
    </div>
  );
}
