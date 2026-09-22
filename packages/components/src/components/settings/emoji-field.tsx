import { lazy, Suspense, useRef, useState } from 'react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';

const EmojiPickerPanel = lazy(() => import('./emoji-picker-panel'));

/**
 * A catalog entry's glyph: the current emoji, and a picker behind it.
 *
 * An always-filled button rather than a text field. Typing an emoji means
 * knowing the OS shortcut, and an empty slot makes "no emoji" look like an
 * unfinished form — so the button shows the default glyph and clicking it is a
 * change, the way a Notion page icon works.
 *
 * Shared by every settings editor that has one, so an Agent Role and a Prompt
 * Shortcut cannot end up with two different emoji controls.
 */
export function EmojiField({
  value,
  defaultEmoji,
  onChange,
}: {
  value: string;
  /** Shown when nothing is set, and offered as the reset. */
  defaultEmoji: string;
  onChange: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The settings editor is a Dialog, whose scroll lock swallows wheel events in
  // a body-level portal — and this popover's whole content is a scrolling list.
  // Same rule as `option-selector.tsx`.
  const portalContainer = open
    ? triggerRef.current?.closest<HTMLElement>('[data-lody-dialog-content]')
    : null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<button
          ref={triggerRef}
          type="button"
          aria-label={t('settings.emoji.label', 'Emoji')}
          className="flex h-9 w-11 shrink-0 items-center justify-center rounded-md border border-input-border bg-input-field text-lg leading-none transition-colors hover:bg-hover/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span aria-hidden="true">{value || defaultEmoji}</span>
        </button>}/>
      <Popover.Content
        align="start"
        className="w-fit p-0"
        container={portalContainer}
        // The list is long and the search field wants the caret; taking focus to
        // the popover root would fight the picker's own keyboard handling.
        initialFocus={false}
      >
        <Suspense
          fallback={
            <div className="flex h-[320px] w-72 items-center justify-center">
              <Spinner className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>
          }
        >
          <EmojiPickerPanel
            onSelect={(emoji) => {
              onChange(emoji);
              setOpen(false);
            }}
          />
        </Suspense>
        {value ? (
          <div className="border-t border-border/60 p-1">
            <Button
              type="button"
              variant="ghost"
              size="small"
              className="h-7 w-full justify-start text-xs text-muted-foreground"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('settings.emoji.reset', {
                defaultValue: 'Reset to {{emoji}}',
                emoji: defaultEmoji,
              })}
            </Button>
          </div>
        ) : null}
      </Popover.Content>
    </Popover.Root>
  );
}
