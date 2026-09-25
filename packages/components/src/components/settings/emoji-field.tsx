import { lazy, Suspense, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';

const EmojiPickerPanel = lazy(() => import('./emoji-picker-panel'));

const FILL = `color-mix(in oklab, transparent, ${colors.label} 6%)`;

const styles = stylex.create({
  /** Edgeless and filling the slot, at the well's radius less the slot's inset. */
  trigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '100%',
    height: '100%',
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: `calc(${radius.medium} - ${space[1]})`,
    cornerShape: corner.shape,
    outline: 'none',
    boxShadow: 'none',
    backgroundColor: { default: 'transparent', ':hover': FILL, ':focus-visible': FILL },
    color: 'inherit',
    fontSize: '16px',
    lineHeight: 1,
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  triggerOpen: { backgroundColor: FILL },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '288px',
    height: '320px',
    color: colors.secondaryLabel,
  },
  /** The reset is the popover's last line: the panel's gap sets it apart, not a rule. */
  reset: { display: 'grid' },
});

/**
 * A catalog entry's glyph: the current emoji, and a picker behind it.
 *
 * An always-filled button rather than a text field. Typing an emoji means
 * knowing the OS shortcut, and an empty slot makes "no emoji" look like an
 * unfinished form — so the button shows the default glyph and clicking it is a
 * change, the way a Notion page icon works.
 *
 * It lives in the name field's `leading` slot, not beside it: the emoji and the
 * name are one label, so they are one control with one edge and one ring. The
 * trigger therefore draws no edge of its own — the well rings on
 * `:focus-within` — and fills the slot, which is already the well's height less
 * its inset, at the well's radius less that inset.
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
      <Popover.Trigger
        render={
          <button
            ref={triggerRef}
            type="button"
            aria-label={t('settings.emoji.label', 'Emoji')}
            {...stylex.props(styles.trigger, open && styles.triggerOpen)}
          >
            <span aria-hidden="true">{value || defaultEmoji}</span>
          </button>
        }
      />
      <Popover.Content
        align="start"
        container={portalContainer}
        // The list is long and the search field wants the caret; taking focus to
        // the popover root would fight the picker's own keyboard handling.
        initialFocus={false}
      >
        <Suspense
          fallback={
            <div {...stylex.props(styles.loading)}>
              <Spinner size="small" aria-hidden="true" />
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
          <div {...stylex.props(styles.reset)}>
            <Button
              type="button"
              variant="ghost"
              size="small"
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
