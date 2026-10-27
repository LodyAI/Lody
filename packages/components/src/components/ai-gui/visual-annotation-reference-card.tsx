'use client';

import type { VisualAnnotationReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { MousePointer2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
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

type VisualAnnotationReferenceCardProps = {
  reference: VisualAnnotationReferencePayload;
  onClick?: () => void;
  className?: string;
};

const styles = stylex.create({
  card: {
    display: 'flex',
    width: '100%',
    maxWidth: '24rem',
    flexDirection: 'column',
    gap: themeSpace[1],
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
    color: 'hsl(var(--foreground) / 0.75)',
  },
  selector: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      'JetBrains Mono, SF Mono, Monaco, Inconsolata, Fira Code, Droid Sans Mono, Source Code Pro, monospace',
    fontSize: '10px',
    color: themeColors.mutedForeground,
  },
});

const getPageLabel = (reference: VisualAnnotationReferencePayload): string => {
  const pathname = reference.anchor.page.pathname.trim();
  if (pathname) {
    return pathname;
  }
  return reference.anchor.page.url;
};

export function VisualAnnotationReferenceCard({
  reference,
  onClick,
  className,
}: VisualAnnotationReferenceCardProps) {
  const target = reference.anchor.target;
  const preview = truncateCommentBody(reference.body, 72);
  const targetText = target.text ? truncateCommentBody(target.text, 72) : undefined;

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
      title={reference.body}
    >
      <div {...stylex.props(styles.heading)}>
        <MousePointer2 {...stylex.props(styles.glyph)} />
        <span {...stylex.props(styles.truncate)}>
          {getPageLabel(reference)} · {target.tag.toLowerCase()}
        </span>
      </div>
      <div {...stylex.props(styles.preview)}>&ldquo;{preview}&rdquo;</div>
      {targetText ? (
        <div {...stylex.props(styles.selector)}>
          {target.selector} · {targetText}
        </div>
      ) : (
        <div {...stylex.props(styles.selector)}>{target.selector}</div>
      )}
    </button>
  );
}
