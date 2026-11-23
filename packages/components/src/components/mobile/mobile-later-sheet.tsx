import * as stylex from '@stylexjs/stylex';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { buildSnoozePresets, type SnoozePresetId } from '@lody/shared';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { toIntlLocale } from '@/lib/intl-locale';
import { isNativeAppShell } from '@/lib/native-platform';
import { useFoldAwareSheetHeight } from './use-vertical-division';

/** Later presets with resolved times plus a custom time; the past is refused. */
export type MobileLaterSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Conversation title shown under the heading. */
  title?: string;
  /** Synced server time; presets and the past-time refusal resolve against it. */
  nowMs: number;
  onPick: (snoozedUntil: number) => void;
};

function toLocalDateTimeInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The custom field's instant, or `null` when it is empty, malformed or not after `nowMs`. */
export function resolveCustomLaterTime(value: string, nowMs: number): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null;
}

/**
 * A preset's resolved time: the clock time alone when it is today, otherwise
 * with its date, so two presets on different Mondays never read the same.
 */
export function presetTimeFormatter(locale: string | undefined, nowMs: number) {
  const intlLocale = toIntlLocale(locale);
  const time = new Intl.DateTimeFormat(intlLocale, { hour: 'numeric', minute: '2-digit' });
  const dated = new Intl.DateTimeFormat(intlLocale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const today = new Date(nowMs).toDateString();
  return (ms: number) =>
    new Date(ms).toDateString() === today ? time.format(ms) : dated.format(ms);
}

function defaultCustomValue(nowMs: number): string {
  const target = new Date(nowMs + 3 * 60 * 60 * 1000);
  target.setSeconds(0, 0);
  const rem = target.getMinutes() % 15;
  if (rem !== 0) target.setMinutes(target.getMinutes() + (15 - rem));
  return toLocalDateTimeInputValue(target.getTime());
}

/** Bottom sheet frame shared by the Later and section-name sheets; both can show a field. */
function MobileFieldSheet({
  open,
  onOpenChange,
  heading,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  heading: string;
  description?: string;
  children: ReactNode;
}) {
  const keyboard = useKeyboardAwareSheet();
  const maxHeight = useFoldAwareSheetHeight(85, true);
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      repositionInputs={isNativeAppShell() ? false : undefined}
    >
      <DrawerContent
        style={{
          maxHeight: `min(${maxHeight}, calc(100dvh - var(--native-keyboard-height, 0px)))`,
        }}
        xstyle={[styles.sheet, keyboard.contentXstyle]}
      >
        <DrawerTitle xstyle={styles.heading}>{heading}</DrawerTitle>
        <DrawerDescription xstyle={styles.description} visuallyHidden={!description}>
          {description || heading}
        </DrawerDescription>
        <div ref={keyboard.scrollRef} style={keyboard.scrollStyle} {...stylex.props(styles.body)}>
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function MobileLaterSheet({
  open,
  onOpenChange,
  title,
  nowMs,
  onPick,
}: MobileLaterSheetProps) {
  const { t, i18n } = useTranslation();
  const [custom, setCustom] = useState(() => defaultCustomValue(nowMs));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCustom(defaultCustomValue(nowMs));
  }
  const presets = useMemo(() => buildSnoozePresets(nowMs), [nowMs]);
  const intlLocale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language);
  const formatPresetTime = useMemo(
    () => presetTimeFormatter(intlLocale, nowMs),
    [intlLocale, nowMs]
  );
  const presetLabel = (id: SnoozePresetId) =>
    id === 'oneHour'
      ? t('sessions.contextMenu.snoozeOneHour', 'In 1 hour')
      : id === 'laterToday'
        ? t('sessions.contextMenu.snoozeLaterToday', 'In 3 hours')
        : id === 'tomorrowMorning'
          ? t('sessions.contextMenu.snoozeTomorrowMorning', 'Tomorrow morning')
          : t('sessions.contextMenu.snoozeNextWeek', 'Next week');
  const customMs = resolveCustomLaterTime(custom, nowMs);
  const pick = (ms: number) => {
    onOpenChange(false);
    onPick(ms);
  };

  return (
    <MobileFieldSheet
      open={open}
      onOpenChange={onOpenChange}
      heading={t('chat.mobileHome.later.title', 'Later')}
      description={title}
    >
      <div {...stylex.props(styles.card)}>
        {presets.map((preset) => (
          <Button
            key={preset.id}
            variant="ghost"
            size="large"
            data-later-preset={preset.id}
            onClick={() => pick(preset.timestamp)}
          >
            <span {...stylex.props(styles.presetRow)}>
              <Clock size={16} aria-hidden="true" {...stylex.props(styles.muted)} />
              <span {...stylex.props(styles.presetLabel)}>{presetLabel(preset.id)}</span>
              <span {...stylex.props(styles.presetTime)}>{formatPresetTime(preset.timestamp)}</span>
            </span>
          </Button>
        ))}
      </div>
      <form
        {...stylex.props(styles.card, styles.customCard, styles.fieldFont)}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (customMs !== null) pick(customMs);
        }}
      >
        <label {...stylex.props(styles.fieldLabel)}>
          {t('sessions.contextMenu.snoozeCustom', 'Custom time…')}
          <Input
            size="large"
            type="datetime-local"
            value={custom}
            min={toLocalDateTimeInputValue(nowMs + 60_000)}
            aria-invalid={customMs === null}
            onChange={(event) => setCustom(event.target.value)}
          />
        </label>
        {customMs === null ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {t('chat.mobileHome.later.pastTime', 'Choose a time in the future.')}
          </p>
        ) : null}
        <Button type="submit" size="large" disabled={customMs === null}>
          {t('chat.mobileHome.later.confirmCustom', 'Later until this time')}
        </Button>
      </form>
    </MobileFieldSheet>
  );
}

/** Name entry for New section and Rename (`specs/pinned-session-sections.md`). */
export function MobileSectionNameSheet({
  open,
  onOpenChange,
  heading,
  initialName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  heading: string;
  initialName: string;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setName(initialName);
  }
  const trimmed = name.trim();
  return (
    <MobileFieldSheet open={open} onOpenChange={onOpenChange} heading={heading}>
      <form
        {...stylex.props(styles.card, styles.customCard, styles.fieldFont)}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!trimmed) return;
          onOpenChange(false);
          onSubmit(trimmed);
        }}
      >
        <label {...stylex.props(styles.fieldLabel)}>
          {t('sidebar.pinSections.namePlaceholder', 'Section name')}
          <Input
            size="large"
            value={name}
            autoFocus
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button type="submit" size="large" disabled={!trimmed}>
          {t('common.save', 'Save')}
        </Button>
      </form>
    </MobileFieldSheet>
  );
}

const styles = stylex.create({
  sheet: {
    height: 'auto',
    borderTopLeftRadius: 'var(--radius-2xl)',
    borderTopRightRadius: 'var(--radius-2xl)',
    borderColor: 'hsl(var(--border) / 0.6)',
  },
  heading: {
    margin: 0,
    paddingInline: space[4],
    paddingTop: space[2],
    textAlign: 'center',
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  description: {
    margin: 0,
    paddingInline: space[4],
    textAlign: 'center',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minHeight: 0,
    flex: 1,
    overflowY: 'auto',
    paddingInline: space[3],
    paddingTop: space[3],
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    padding: space[1],
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.raisedBackground,
  },
  customCard: { gap: space[2], padding: space[3] },
  /** iOS Safari zooms into a field set under 16px; the input follows this token. */
  fieldFont: { '--ui-font-size': '16px' },
  presetRow: { display: 'flex', alignItems: 'center', gap: space[3], width: '100%' },
  presetLabel: { flex: 1, minWidth: 0, textAlign: 'start' },
  presetTime: { color: colors.secondaryLabel, fontVariantNumeric: 'tabular-nums' },
  muted: { color: colors.secondaryLabel, flexShrink: 0 },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  error: { margin: 0, fontSize: text.footnoteSize, color: colors.destructive },
});
