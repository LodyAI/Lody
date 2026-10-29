import {
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
  EmojiPicker as EmojiPickerPrimitive,
} from 'frimousse';
import { SearchIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

/**
 * shadcn's `frimousse` emoji picker, kept as the registry ships it apart from
 * three changes this repo requires: the `"use client"` banner is dropped (there
 * is no RSC boundary here), its two visible strings go through i18n, and it
 * carries no surface color of its own. The registry's `bg-popover` resolves to
 * `--popover`, which `vscode-theme-css.ts` derives from the theme's widget
 * background — under Vesper that is `#101010`, darker than the `@lody/ui`
 * popup surface (`colors.raisedBackground`) the picker always renders inside,
 * so the picker sat as a near-black slab on a lighter panel. The root is
 * therefore transparent, and the one part that still needs a fill — the sticky
 * category header — takes the popup rung's color directly.
 */
const styles = stylex.create({
  root: {
    isolation: 'isolate',
    display: 'flex',
    height: '100%',
    width: 'fit-content',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: themeRadius.md,
  },
  searchWrapper: {
    display: 'flex',
    height: themeSpace[9],
    alignItems: 'center',
    gap: themeSpace[2],
    borderBottomStyle: 'var(--tw-border-style, solid)',
    borderBottomWidth: 1,
    paddingInline: themeSpace[3],
  },
  searchIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    opacity: 0.5,
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
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    boxShadow: { default: null, ':focus-visible': 'none' },
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
    '::placeholder': { color: themeColors.mutedForeground },
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
  },
  categoryHeader: {
    // Sticky rows cover the scrolling emoji with the containing popup's surface.
    backgroundColor: colors.raisedBackground,
    color: themeColors.mutedForeground,
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
    color: themeColors.mutedForeground,
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
    borderTopStyle: 'var(--tw-border-style, solid)',
    borderTopWidth: 1,
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
    color: themeColors.secondaryForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  placeholder: {
    color: themeColors.mutedForeground,
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
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Root>) {
  return (
    <EmojiPickerPrimitive.Root
      className={cn(stylex.props(styles.root).className, className)}
      data-slot="emoji-picker"
      {...props}
    />
  );
}

function EmojiPickerSearch({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Search>) {
  return (
    <div
      className={cn(stylex.props(styles.searchWrapper).className, className)}
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
      className={cn(
        stylex.props(styles.emoji).className,
        // Preserve the app's nested light/dark scope predicate and overlay fills.
        'data-[active]:bg-foreground/[0.05] dark:data-[active]:bg-white/[0.10]',
        className
      )}
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
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport>) {
  const { t } = useTranslation();
  return (
    <EmojiPickerPrimitive.Viewport
      className={cn(stylex.props(styles.viewport).className, className)}
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

function EmojiPickerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(stylex.props(styles.footer).className, className)}
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
