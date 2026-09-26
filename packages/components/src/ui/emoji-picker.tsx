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
  // frimousse sticks category headers to the viewport's top while their rows
  // scroll underneath, so the header needs the surface's own opaque color.
  categoryHeader: { backgroundColor: colors.raisedBackground },
});

function EmojiPicker({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Root>) {
  return (
    <EmojiPickerPrimitive.Root
      className={cn('isolate flex h-full w-fit flex-col overflow-hidden rounded-md', className)}
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
      className={cn('flex h-9 items-center gap-2 border-b px-3', className)}
      data-slot="emoji-picker-search-wrapper"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      {/* `focus-visible:shadow-none` opts out of the app's global inset focus
          ring (tailwind/index.css, "Pro focus style": an inset 1px `--primary`
          box-shadow on any focused input). That `:where(…)` selector carries no
          specificity, so every other input in the app overrides it with its own
          `focus-visible:` utility and never shows it — this bare registry input
          had none, so it was the one field in the app that did, drawing an
          accent box inside the row's own divider the moment it was typed in.
          The caret is the focus affordance here, as it is everywhere else. */}
      <EmojiPickerPrimitive.Search
        className="outline-hidden placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm focus-visible:shadow-none disabled:cursor-not-allowed disabled:opacity-50"
        data-slot="emoji-picker-search"
        {...props}
      />
    </div>
  );
}

function EmojiPickerRow({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div {...props} className="scroll-my-1 px-1" data-slot="emoji-picker-row">
      {children}
    </div>
  );
}

function EmojiPickerEmoji({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      {...props}
      className={cn(
        // The registry's `bg-accent` is dead here: `--accent` is never
        // declared, so the fill silently resolved to nothing. Use the overlay
        // list hover fill the rest of the app's floating surfaces use.
        'data-[active]:bg-foreground/[0.05] dark:data-[active]:bg-white/[0.10] flex size-7 items-center justify-center rounded-sm text-base',
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
      className={cn(sx.className, 'text-muted-foreground px-3 pb-2 pt-3.5 text-xs leading-none')}
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
      className={cn('outline-hidden relative flex-1', className)}
      data-slot="emoji-picker-viewport"
      {...props}
    >
      <EmojiPickerPrimitive.Loading
        className="absolute inset-0 flex items-center justify-center text-muted-foreground"
        data-slot="emoji-picker-loading"
      >
        <Spinner className="size-4" />
      </EmojiPickerPrimitive.Loading>
      <EmojiPickerPrimitive.Empty
        className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm"
        data-slot="emoji-picker-empty"
      >
        {t('emojiPicker.empty', 'No emoji found.')}
      </EmojiPickerPrimitive.Empty>
      <EmojiPickerPrimitive.List
        className="select-none pb-1"
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
      className={cn(
        'max-w-(--frimousse-viewport-width) flex w-full min-w-0 items-center gap-1 border-t p-2',
        className
      )}
      data-slot="emoji-picker-footer"
      {...props}
    >
      <EmojiPickerPrimitive.ActiveEmoji>
        {({ emoji }) =>
          emoji ? (
            <>
              <div className="flex size-7 flex-none items-center justify-center text-lg">
                {emoji.emoji}
              </div>
              <span className="text-secondary-foreground truncate text-xs">{emoji.label}</span>
            </>
          ) : (
            <span className="text-muted-foreground ml-1.5 flex h-7 items-center truncate text-xs">
              {t('emojiPicker.placeholder', 'Select an emoji…')}
            </span>
          )
        }
      </EmojiPickerPrimitive.ActiveEmoji>
    </div>
  );
}

export { EmojiPicker, EmojiPickerSearch, EmojiPickerContent, EmojiPickerFooter };
