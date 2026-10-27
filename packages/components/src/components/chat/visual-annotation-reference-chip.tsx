'use client';

import { useState } from 'react';
import { MousePointer2, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { VisualAnnotationReferencePayload } from '@lody/shared';
import { truncateCommentBody } from '@lody/shared';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

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

const styles = stylex.create({
  chip: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
    maxWidth: 'calc(var(--spacing) * 64)',
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: 'hsl(var(--muted) / 0.5)',
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  /** A chip that answers a click: the pointer's fill, and the colour move with it. */
  chipInteractive: {
    cursor: 'pointer',
    backgroundColor: { default: 'hsl(var(--muted) / 0.5)', ':hover': themeColors.hover },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    color: themeColors.mutedForeground,
  },
  pointerGlyph: { width: themeSpace[3], height: themeSpace[3], flexShrink: 0 },
  target: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: themeFontWeight.medium,
  },
  remove: {
    marginLeft: 'auto',
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xs,
    color: { default: 'hsl(var(--muted-foreground) / 0.6)', ':hover': themeColors.mutedForeground },
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--muted-foreground) / 0.2)',
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    pointerEvents: 'none',
    opacity: 0,
  },
  removeVisible: { pointerEvents: 'auto', opacity: 1 },
  removeGlyph: { width: themeSpace[3], height: themeSpace[3] },
  preview: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--foreground) / 0.7)',
  },
  selector: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    color: themeColors.mutedForeground,
  },
});

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

  // `group/chip` and the group-hover utilities stay Tailwind: StyleX has no
  // ancestor selector, so the chip's hover reveal cannot live in a style. The
  // caller's own class rides the element as a plain attribute, so it still
  // beats the component's style from the `utilities` layer.
  const chipStyle = stylex.props(styles.chip, isInteractive && styles.chipInteractive);
  const chipClassName = ['group/chip', chipStyle.className, className].filter(Boolean).join(' ');
  const removeStyle = stylex.props(styles.remove, removeVisible && styles.removeVisible);
  const removeClassName = [
    removeStyle.className,
    'group-hover/chip:pointer-events-auto group-hover/chip:opacity-100',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      data-visual-annotation-ref
      className={chipClassName}
      style={chipStyle.style}
      onClick={
        isInteractive
          ? () => {
              setRemoveVisible(true);
            }
          : undefined
      }
    >
      <div {...stylex.props(styles.head)}>
        <MousePointer2 className={stylex.props(styles.pointerGlyph).className} />
        <span {...stylex.props(styles.target)}>
          {getPageLabel(reference)} · {target.tag.toLowerCase()}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(item.localId);
            }}
            className={removeClassName}
            style={removeStyle.style}
            aria-label="Remove visual annotation reference"
          >
            <X className={stylex.props(styles.removeGlyph).className} />
          </button>
        ) : null}
      </div>
      <div {...stylex.props(styles.preview)}>&ldquo;{preview}&rdquo;</div>
      {/* `font-mono` is the app's own global class (it also sets the ligatures),
          so it stays a plain class beside this style. */}
      <div
        className={['font-mono', stylex.props(styles.selector).className].filter(Boolean).join(' ')}
      >
        {target.selector}
      </div>
    </div>
  );
}
