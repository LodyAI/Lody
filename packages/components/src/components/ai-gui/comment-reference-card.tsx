'use client';

import type { CommentReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { FileIcon } from '@/components/icons/file-icons';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

interface CommentReferenceCardProps {
  reference: CommentReferencePayload;
  onClick?: () => void;
  className?: string;
}

const styles = stylex.create({
  card: {
    display: 'flex',
    width: '100%',
    maxWidth: '24rem',
    flexDirection: 'column',
    gap: themeSpace[0.5],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    textAlign: 'left',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.4)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted) / 0.7)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  cardInteractive: { cursor: 'pointer' },
  cardStatic: { cursor: 'default' },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  glyph: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  preview: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--foreground) / 0.7)',
  },
});

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

/**
 * Compact card shown in user chat bubbles for comment references.
 * Displays file path, line number, and a truncated comment preview.
 * Clicking navigates to the corresponding diff position.
 */
export function CommentReferenceCard({ reference, onClick, className }: CommentReferenceCardProps) {
  const fileName = getFileNameFromPath(reference.path);
  const preview = truncateCommentBody(reference.commentBody, 60);

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        stylex.props(
          styles.card,
          onClick ? styles.cardInteractive : styles.cardStatic
        ).className,
        className
      )}
      title={reference.commentBody}
    >
      <div {...stylex.props(styles.heading)}>
        <FileIcon filePath={reference.path} className={stylex.props(styles.glyph).className} />
        <span {...stylex.props(styles.truncate)}>
          {fileName}:{reference.lineNumber}
        </span>
      </div>
      <div {...stylex.props(styles.preview)}>&ldquo;{preview}&rdquo;</div>
    </button>
  );
}
