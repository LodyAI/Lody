import {
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
  EmojiPicker as EmojiPickerPrimitive,
} from 'frimousse';
import { SearchIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { popup } from '@lody/ui/popup/popup.tokens.stylex';
import { control, corner, text } from '@lody/ui/tokens/scales.stylex';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';

import { clsx } from 'clsx';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

/** Frimousse owns search and navigation; the skin shares field and popup roles.
 * The containing popup owns its floating material, so the picker stays transparent.
 */
const styles = stylex.create({
  root: {
    isolation: 'isolate',
    display: 'flex',
    height: '100%',
    width: 'fit-content',
    flexDirection: 'column',
    borderRadius: themeRadius.md,
  },
  searchWrapper: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    height: themeSpace[9],
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: field.radiusMedium,
    cornerShape: corner.round,
    backgroundColor: field.background,
    boxShadow: {
      default: field.well,
      ':focus-within': `0 0 0 ${field.ringWidth} ${field.ring}, ${field.well}`,
    },
    color: field.value,
    opacity: {
      default: 1,
      ':has([data-slot="emoji-picker-search"]:disabled)': control.disabledOpacity,
    },
    paddingInline: themeSpace[3],
  },
  searchIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: field.icon,
  },
  search: {
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': 2 },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': 2 },
    display: 'flex',
    height: themeSpace[10],
    width: '100%',
    borderRadius: themeRadius.md,
    backgroundColor: 'transparent',
    borderWidth: 0,
    color: field.value,
    paddingBlock: themeSpace[3],
    fontSize: field.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    boxShadow: { default: null, ':focus-visible': 'none' },
    cursor: { default: null, ':disabled': 'default' },
    '::placeholder': { color: field.placeholder, opacity: 1 },
  },
  row: { scrollMarginBlock: themeSpace[1], paddingInline: themeSpace[1] },
  emoji: {
    display: 'flex',
    width: themeSpace[7],
    height: themeSpace[7],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.sm,
    fontSize: themeFontSize.base,
    lineHeight: themeLineHeight.base,
    backgroundColor: { default: null, ':is([data-active])': popup.highlight },
  },
  categoryHeader: {
    // Sticky rows cover the scrolling emoji with the containing popup's surface.
    backgroundColor: popup.background,
    color: popup.groupLabel,
    paddingInline: themeSpace[3],
    paddingBottom: themeSpace[2],
    paddingTop: themeSpace[3.5],
    fontSize: themeFontSize.xs,
    lineHeight: 1,
  },
  viewport: {
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': 2 },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': 2 },
    position: 'relative',
    flex: '1 1 0%',
  },
  feedback: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: popup.hint,
  },
  empty: { fontSize: themeFontSize.sm, lineHeight: themeLineHeight.sm },
  list: { userSelect: 'none', paddingBottom: themeSpace[1] },
  footer: {
    maxWidth: 'var(--frimousse-viewport-width)',
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    padding: themeSpace[2],
  },
  activeEmoji: {
    display: 'flex',
    width: themeSpace[7],
    height: themeSpace[7],
    flex: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: themeFontSize.lg,
    lineHeight: themeLineHeight.lg,
  },
  activeLabel: {
    color: popup.label,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  placeholder: {
    color: popup.hint,
    marginLeft: themeSpace[1.5],
    display: 'flex',
    height: themeSpace[7],
    alignItems: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
});

function EmojiPicker({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Root> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.root, xstyle);
  return (
    <EmojiPickerPrimitive.Root
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      data-slot="emoji-picker"
      {...props}
    />
  );
}

function EmojiPickerSearch({
  className,
  xstyle,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Search> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.searchWrapper, xstyle);
  return (
    <div
      className={clsx(sx.className, className)}
      style={sx.style}
      data-slot="emoji-picker-search-wrapper"
    >
      <SearchIcon {...stylex.props(styles.searchIcon)} />
      {/* The caret supplies focus feedback; neutralize the app's global inset input shadow. */}
      <EmojiPickerPrimitive.Search
        className={stylex.props(styles.search).className}
        data-slot="emoji-picker-search"
        {...props}
      />
    </div>
  );
}

function EmojiPickerRow({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div {...props} className={stylex.props(styles.row).className} data-slot="emoji-picker-row">
      {children}
    </div>
  );
}

function EmojiPickerEmoji({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      {...props}
      className={clsx(stylex.props(styles.emoji).className, className)}
      data-slot="emoji-picker-emoji"
    >
      {emoji.emoji}
    </button>
  );
}

function EmojiPickerCategoryHeader({
  category,
  style,
  ...props
}: EmojiPickerListCategoryHeaderProps) {
  const sx = stylex.props(styles.categoryHeader);
  return (
    <div
      {...props}
      className={sx.className}
      style={{ ...sx.style, ...style }}
      data-slot="emoji-picker-category-header"
    >
      {category.label}
    </div>
  );
}

function EmojiPickerContent({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport> & { xstyle?: stylex.StyleXStyles }) {
  const { t } = useTranslation();
  const sx = stylex.props(styles.viewport, xstyle);
  return (
    <EmojiPickerPrimitive.Viewport
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      data-slot="emoji-picker-viewport"
      {...props}
    >
      <EmojiPickerPrimitive.Loading
        className={stylex.props(styles.feedback).className}
        data-slot="emoji-picker-loading"
      >
        <Spinner diameter="calc(var(--spacing) * 4)" />
      </EmojiPickerPrimitive.Loading>
      <EmojiPickerPrimitive.Empty
        className={stylex.props(styles.feedback, styles.empty).className}
        data-slot="emoji-picker-empty"
      >
        {t('emojiPicker.empty', 'No emoji found.')}
      </EmojiPickerPrimitive.Empty>
      <EmojiPickerPrimitive.List
        className={stylex.props(styles.list).className}
        components={{
          Row: EmojiPickerRow,
          Emoji: EmojiPickerEmoji,
          CategoryHeader: EmojiPickerCategoryHeader,
        }}
        data-slot="emoji-picker-list"
      />
    </EmojiPickerPrimitive.Viewport>
  );
}

function EmojiPickerFooter({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles }) {
  const { t } = useTranslation();
  const sx = stylex.props(styles.footer, xstyle);
  return (
    <div
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      data-slot="emoji-picker-footer"
      {...props}
    >
      <EmojiPickerPrimitive.ActiveEmoji>
        {({ emoji }) =>
          emoji ? (
            <>
              <div {...stylex.props(styles.activeEmoji)}>{emoji.emoji}</div>
              <span {...stylex.props(styles.activeLabel)}>{emoji.label}</span>
            </>
          ) : (
            <span {...stylex.props(styles.placeholder)}>
              {t('emojiPicker.placeholder', 'Select an emoji…')}
            </span>
          )
        }
      </EmojiPickerPrimitive.ActiveEmoji>
    </div>
  );
}

export { EmojiPicker, EmojiPickerSearch, EmojiPickerContent, EmojiPickerFooter };
