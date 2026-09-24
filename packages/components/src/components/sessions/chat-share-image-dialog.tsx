import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { Check, Copy, Download, Slash, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { estimateTokenCount, type SessionMeta, type ConversationMessage } from '@lody/shared';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
import {
  control,
  corner,
  duration,
  ease,
  radius,
  space,
  text,
} from '@lody/ui/tokens/scales.stylex';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { useIsMobile } from '@/hooks/use-mobile';
import { useResolvedTheme } from '@/theme-provider';
import { Dialog } from '@/ui/dialog';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Slider } from '@/ui/slider';
import { copyShareImage, exportShareImage } from '@/lib/share-image-export';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import {
  ChatShareCard,
  CHAT_SHARE_BACKDROPS,
  CHAT_SHARE_BACKDROP_STYLES,
  DEFAULT_MAT,
  MAT_STEP,
  MAX_MAT,
  MIN_MAT,
  type ChatShareCardBackdrop,
  type ChatShareCardDestination,
} from '@/components/share-card/chat-share-card';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';

const RING = `0 0 0 2px ${colors.accent}`;
const HOVER_RING = `0 0 0 2px color-mix(in oklab, transparent, ${colors.accent} 40%)`;
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;
/** A segment's corner: the track's, less the inset it keeps from it. */
const SEGMENT_RADIUS = `calc(${radius.medium} - 2px)`;

const styles = stylex.create({
  // The preview scrolls in its own column: a card taller than the surface is
  // the ordinary case, so the column's height comes from the flex parent.
  fitScroller: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    width: '100%',
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  fitSpacer: { position: 'relative', marginInline: 'auto' },
  fitContent: {
    position: 'absolute',
    insetInlineStart: 0,
    insetBlockStart: 0,
    width: 'fit-content',
    transformOrigin: 'top left',
  },
  exportFrame: { width: 'fit-content' },
  agentIcon: { width: '20px', height: '20px' },

  // A two-way choice is a strip, as `@lody/ui`'s Tabs draw one: a flat tray with
  // the chosen one standing on it.
  track: {
    display: 'inline-grid',
    gridTemplateColumns: '1fr 1fr',
    flexShrink: 0,
    boxSizing: 'border-box',
    height: control.medium,
    padding: '2px',
    backgroundColor: colors.trayBackground,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  segment: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '56px',
    margin: 0,
    paddingBlock: 0,
    paddingInline: space[3],
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: SEGMENT_RADIUS,
    cornerShape: corner.round,
    backgroundColor: 'transparent',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    whiteSpace: 'nowrap',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.45 },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
    transitionProperty: 'color, background-color, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  segmentWide: { minWidth: '64px' },
  segmentSelected: {
    backgroundColor: colors.trayRaised,
    backgroundImage: sheen.raised,
    color: colors.label,
    boxShadow: { default: shadow.raised, ':focus-visible': `${RING}, ${shadow.raised}` },
  },

  labelled: { display: 'flex', alignItems: 'center', gap: space[2] },
  controlLabel: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  dimmed: { opacity: 0.45 },

  swatches: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  // A swatch is a pressable that paints its ground: raised, no edge of its own,
  // and the accent ring says which one is chosen.
  swatch: {
    position: 'relative',
    flexShrink: 0,
    boxSizing: 'border-box',
    width: control.small,
    height: control.small,
    margin: 0,
    padding: 0,
    overflow: 'hidden',
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.small,
    cornerShape: corner.round,
    backgroundColor: colors.raisedBackground,
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.45 },
    outlineStyle: 'none',
    boxShadow: {
      default: shadow.raised,
      ':hover': `${shadow.raised}, ${HOVER_RING}`,
      ':focus-visible': `${RING}, ${shadow.raised}`,
    },
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  swatchSelected: {
    boxShadow: {
      default: `${RING}, ${shadow.raised}`,
      ':hover': `${RING}, ${shadow.raised}`,
      ':focus-visible': `${RING}, ${shadow.raised}`,
    },
  },
  swatchNone: {
    position: 'absolute',
    inset: 0,
    width: '14px',
    height: '14px',
    margin: 'auto',
    color: colors.tertiaryLabel,
  },
  swatchCheck: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'hsl(0 0% 0% / 0.15)',
    color: 'white',
  },
  swatchCheckGlyph: {
    width: '14px',
    height: '14px',
    filter: 'drop-shadow(0 1px 1px hsl(0 0% 0% / 0.35))',
  },

  mat: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    alignItems: 'center',
    gap: space[3],
    minWidth: '208px',
  },
  slider: { flexGrow: 1, flexShrink: 1, minWidth: '96px' },
  matValue: {
    flexShrink: 0,
    width: '28px',
    textAlign: 'end',
    fontFamily: 'var(--font-mono)',
    fontSize: text.footnoteSize,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },

  empty: {
    display: 'flex',
    flexGrow: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: text.bodySize,
    color: colors.secondaryLabel,
  },
  status: {
    margin: 0,
    marginInlineEnd: 'auto',
    alignSelf: 'center',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  statusError: { color: colors.destructive },
  statusInfo: { color: colors.secondaryLabel },
  glyph16: { display: 'block', flexShrink: 0, width: '16px', height: '16px' },
  glyphFill: { display: 'block', width: '100%', height: '100%' },

  // The preview is a block inside the panel: the region fill, no edge, on the
  // panel's own padding rather than a band bled to its edges.
  preview: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    padding: space[6],
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  controls: { display: 'flex', flexDirection: 'column', gap: space[3], flexShrink: 0 },
  controlRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '20px',
    rowGap: space[3],
  },
  footer: { flexShrink: 0 },

  // Drawer: the same preview, controls and actions, stacked for a thumb.
  drawerBody: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: space[3],
    minHeight: 0,
    paddingInline: space[4],
    paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
  },
  drawerHeader: {
    position: 'relative',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: control.large,
    paddingTop: space[2],
  },
  drawerTitle: { fontSize: text.headlineSize, lineHeight: text.headlineLeading },
  drawerClose: { position: 'absolute', insetInlineEnd: '-4px', insetBlockStart: space[1] },
  drawerPreview: { padding: space[4] },
  drawerControls: { display: 'flex', flexDirection: 'column', gap: space[3], flexShrink: 0 },
  drawerRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: space[4],
    rowGap: space[3],
  },
  drawerActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[2] },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});

/** Opening ground: the brand's own, so an untouched export is the signature card. */
const DEFAULT_BACKDROP: ChatShareCardBackdrop = 'lody';

/**
 * The destination is the user's to state, but it still needs an opening guess,
 * and the device is the best one available: most images exported from a handset
 * are going into a conversation, most exported from a desktop are going somewhere
 * they will be read on their own. This is the only thing the device decides, and
 * one tap overrides it.
 */
const defaultDestination = (isMobile: boolean): ChatShareCardDestination =>
  isMobile ? 'chat' : 'post';

/** Capture date on the card: fixed `YYYY-MM-DD HH:mm` regardless of product language. */
function formatShareImageDate(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Scales the card to the preview panel's width so it stays readable; taller
 * cards scroll vertically instead of shrinking into a thumbnail. The card
 * keeps its natural layout width; only the preview transform changes.
 *
 * It takes its height from the flex column it sits in (`flex-1` + `min-h-0`)
 * rather than a percentage: a card is taller than the surface far more often
 * than not, and a percentage height that fails to resolve leaves the scroller
 * unbounded, so the card paints straight over the action row.
 */
function FitPreview({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [scaledSize, setScaledSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return undefined;
    const update = () => {
      // offsetWidth/offsetHeight ignore the element's own transform, so they
      // report the unscaled card size even after we shrink it.
      const width = content.offsetWidth;
      const height = content.offsetHeight;
      if (!width || !height || !container.clientWidth) return;
      const next = Math.min(1, container.clientWidth / width);
      setScale(next);
      // The transform does not affect layout, so size the spacer explicitly;
      // otherwise the scroll area keeps the unscaled height.
      setScaledSize({ width: width * next, height: height * next });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} {...stylex.props(styles.fitScroller)}>
      <div
        className={stylex.props(styles.fitSpacer).className}
        style={
          scaledSize
            ? { width: scaledSize.width, height: scaledSize.height }
            : { width: 'fit-content' }
        }
      >
        <div
          ref={contentRef}
          className={stylex.props(styles.fitContent).className}
          style={{ transform: `scale(${scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Two-state palette switch: the card's own light and dark, not the app's. */
function PaletteToggle({
  value,
  onChange,
  disabled,
}: {
  value: 'light' | 'dark';
  onChange: (theme: 'light' | 'dark') => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const options = [
    { value: 'light' as const, label: t('sessions.shareImage.themeLight', 'Light') },
    { value: 'dark' as const, label: t('sessions.shareImage.themeDark', 'Dark') },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t('sessions.shareImage.theme', 'Theme')}
      {...stylex.props(styles.track)}
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            {...stylex.props(
              styles.segment,
              styles.segmentWide,
              selected && styles.segmentSelected
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The card's size, asked as where the image is going. It is a preset, not just a
 * width: picking one also re-seeds the mat to that size's ordinary look, which is
 * what makes the pair of controls read as "pick a starting point, then adjust"
 * rather than as two unrelated knobs.
 */
function DestinationToggle({
  value,
  onChange,
  disabled,
}: {
  value: ChatShareCardDestination;
  onChange: (destination: ChatShareCardDestination) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label = t('sessions.shareImage.destination', 'Sharing to');
  const options = [
    { value: 'chat' as const, label: t('sessions.shareImage.destinationChat', 'Chat') },
    { value: 'post' as const, label: t('sessions.shareImage.destinationPost', 'Post') },
  ];
  return (
    <div {...stylex.props(styles.labelled)}>
      <span
        id="chat-share-destination-label"
        {...stylex.props(styles.controlLabel, disabled && styles.dimmed)}
      >
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="chat-share-destination-label"
        {...stylex.props(styles.track)}
      >
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              {...stylex.props(styles.segment, selected && styles.segmentSelected)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Backdrop swatches. Each option paints the gradient it stands for, because a
 * word cannot describe a ground and this is the one choice left in the preview;
 * `none` is drawn as an absent ground rather than named, so the row reads as one
 * control instead of a button plus five swatches.
 */
function BackdropPicker({
  value,
  onChange,
  disabled,
}: {
  value: ChatShareCardBackdrop;
  onChange: (backdrop: ChatShareCardBackdrop) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t('sessions.shareImage.backdrop', 'Background')}
      {...stylex.props(styles.swatches)}
    >
      {CHAT_SHARE_BACKDROPS.map((backdrop) => {
        const selected = value === backdrop;
        const label = t(
          `sessions.shareImage.backdrop${backdrop[0].toUpperCase()}${backdrop.slice(1)}`,
          backdrop
        );
        return (
          <button
            key={backdrop}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(backdrop)}
            className={stylex.props(styles.swatch, selected && styles.swatchSelected).className}
            style={backdrop === 'none' ? undefined : CHAT_SHARE_BACKDROP_STYLES[backdrop]}
          >
            {backdrop === 'none' ? (
              <Slash {...stylex.props(styles.swatchNone)} aria-hidden="true" />
            ) : null}
            {selected ? (
              <span {...stylex.props(styles.swatchCheck)}>
                <Check {...stylex.props(styles.swatchCheckGlyph)} aria-hidden="true" />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The mat, as a slider over pixels.
 *
 * This is the one dimension the template does not decide, and it is the one
 * control here that is honestly a measurement. The usual argument against
 * exposing a number — that nobody can judge 32 against 56 — holds on a settings
 * screen and dissolves next to a live preview: you do not read the value, you
 * drag and watch the picture. Quantising a continuous quantity into two or three
 * named buckets would be the designer choosing for the user in the one place the
 * user can see the answer directly.
 *
 * The readout is the pixel count so the look is reproducible, the step is the
 * template's own 4px grid, and zero is reachable — a card flush to the image edge
 * is what pasting into a document wants. Below `MIN_SIGN_OFF_MAT` the card signs
 * itself in its caption instead, so the tight end never puts type on the edge.
 */
function MatSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (mat: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label = t('sessions.shareImage.mat', 'Padding');
  return (
    <div {...stylex.props(styles.mat)}>
      <span
        id="chat-share-mat-label"
        {...stylex.props(styles.controlLabel, disabled && styles.dimmed)}
      >
        {label}
      </span>
      {/* The slider dims itself when disabled; its label and readout dim beside it. */}
      <Slider
        aria-labelledby="chat-share-mat-label"
        min={MIN_MAT}
        max={MAX_MAT}
        step={MAT_STEP}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        className={stylex.props(styles.slider).className}
      />
      <span {...stylex.props(styles.matValue, disabled && styles.dimmed)}>{value}</span>
    </div>
  );
}

export interface ChatShareImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Session the card is captured from; drives the card's caption band. */
  session: SessionMeta | null;
  /**
   * Messages to render, already filtered by the caller. Round selection is a
   * chat-surface interaction (IM-style multi-select), not part of this dialog.
   */
  messages: ConversationMessage[];
  /** Custom Runtime's configured display name. */
  agentName?: string;
  /**
   * Seeds the destination instead of guessing it from the device. Stories use it
   * to open on either card; the product never passes it.
   */
  initialDestination?: ChatShareCardDestination;
  /**
   * The image reached its destination — copied, or actually written to disk. The
   * host ends the whole flow here, this surface and the selection behind it. It
   * does NOT fire for a dismissal or for a cancelled save dialog: backing out of
   * a file picker is not a finished share, and tidying the selection away under
   * someone who did that would lose work they still had in hand.
   *
   * Which action finished is passed on because the two have different feedback
   * left behind them. A save has the native dialog or the browser's own download
   * UI; a copy has nothing once this surface is gone, so the host is the only
   * place left to say it worked.
   */
  onCompleted?: (action: 'copied' | 'saved') => void;
}

/**
 * Preview and export for "Share as image". The card is a fixed template, so this
 * surface is a preview with four controls and two actions rather than an editor.
 * Two of them are the card's shape — where the image is going, which sets its
 * width and seeds its mat, and the mat itself on a slider — and two are its
 * surface: the ground it is printed on and the palette it is printed in. Its
 * bands, their order, their gutters and their type are not on offer. The device
 * chooses nothing about the image, only the opening guess at its destination and
 * whether this surface is a dialog or a drawer.
 *
 * The same preview, controls and actions render in a bottom drawer on a handset
 * and in a dialog on a desktop.
 */
export function ChatShareImageDialog({
  open,
  onOpenChange,
  session,
  messages,
  agentName,
  initialDestination,
  onCompleted,
}: ChatShareImageDialogProps) {
  const { t, i18n } = useTranslation();
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const appTheme = useResolvedTheme() === 'dark' ? 'dark' : 'light';
  const modelName = messages.findLast((message) => message.role === 'assistant')?.modelName;
  const selectedTokenCount = useMemo(
    () =>
      messages.reduce(
        (total, message) => total + (message.estimatedTokens ?? estimateTokenCount(message.text)),
        0
      ),
    [messages]
  );
  const [theme, setTheme] = useState<'light' | 'dark'>(appTheme);
  const [backdrop, setBackdrop] = useState<ChatShareCardBackdrop>(DEFAULT_BACKDROP);
  const [destination, setDestination] = useState<ChatShareCardDestination>(
    initialDestination ?? defaultDestination(isMobile)
  );
  const [mat, setMat] = useState<number>(
    DEFAULT_MAT[initialDestination ?? defaultDestination(isMobile)]
  );

  // Picking a size is picking a starting point, so it re-seeds the mat. There is
  // no "has the user touched the slider" bit behind this on purpose: a hidden
  // flag that sometimes keeps a value and sometimes does not is harder to predict
  // than a preset that always resets, and the preview shows the result instantly.
  const chooseDestination = (next: ChatShareCardDestination) => {
    setDestination(next);
    setMat(DEFAULT_MAT[next]);
  };
  const exportRef = useRef<HTMLDivElement>(null);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<'copy' | 'export' | null>(null);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);

  // Render-phase reset: every opening starts from the app's current appearance
  // with no stale result banner. An effect would paint the previous run's state
  // for one frame.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setTheme(appTheme);
      setBackdrop(DEFAULT_BACKDROP);
      const opening = initialDestination ?? defaultDestination(isMobile);
      setDestination(opening);
      setMat(DEFAULT_MAT[opening]);
      setExportError(false);
      setCopied(false);
    }
  }

  const handleExport = async () => {
    if (!exportRef.current || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setOperation('export');
    setExportError(false);
    try {
      const { saved } = await exportShareImage(
        exportRef.current,
        session?.title,
        'lody-conversation'
      );
      if (saved) {
        capturePostHogEvent(postHog, 'export/chat_png_created', {
          message_count: messages.length,
        });
        onCompleted?.('saved');
      }
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setOperation(null);
    }
  };

  const handleCopy = async () => {
    if (!exportRef.current || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setOperation('copy');
    setExportError(false);
    setCopied(false);
    try {
      await copyShareImage(exportRef.current);
      capturePostHogEvent(postHog, 'export/chat_png_copied', { message_count: messages.length });
      setCopied(true);
      onCompleted?.('copied');
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setOperation(null);
    }
  };

  const meta = useMemo(() => {
    const runtimeName =
      agentName || (session ? getAgentDisplayName(session.cliType, session.agentType) : undefined);
    const params = [
      modelName,
      selectedTokenCount > 0
        ? t('sessions.shareImage.estimatedTokens', '~{{value}} tokens', {
            value: formatCompactNumber(selectedTokenCount, intlLocale),
          })
        : undefined,
    ].filter((param): param is string => Boolean(param));
    return {
      name: runtimeName ?? 'Lody',
      params,
      date: formatShareImageDate(session?.createdAt),
      icon:
        session?.cliType && session.agentType ? (
          <AgentIcon
            cliType={session.cliType}
            agentType={session.agentType}
            className={stylex.props(styles.agentIcon).className}
          />
        ) : undefined,
    };
  }, [session, agentName, modelName, selectedTokenCount, intlLocale, t]);

  const hasMessages = messages.length > 0;
  const dialogTitle = t('sessions.shareImage.dialogTitle', 'Share as image');

  const preview = hasMessages ? (
    <FitPreview>
      <div ref={exportRef} {...stylex.props(styles.exportFrame)}>
        <ChatShareCard
          messages={messages}
          title={session?.title?.trim() || undefined}
          destination={destination}
          mat={mat}
          theme={theme}
          backdrop={backdrop}
          meta={meta}
        />
      </div>
    </FitPreview>
  ) : (
    <div {...stylex.props(styles.empty)}>
      {t('sessions.shareImage.empty', 'No conversation to share')}
    </div>
  );

  const status = exportError ? (
    <p role="alert" {...stylex.props(styles.status, styles.statusError)}>
      {t(
        'sessions.shareImage.exportFailed',
        'Could not complete the image action. Please try again.'
      )}
    </p>
  ) : copied ? (
    <p role="status" {...stylex.props(styles.status, styles.statusInfo)}>
      {t('sessions.shareImage.copied', 'Image copied to clipboard')}
    </p>
  ) : null;

  // The dialog's actions take the small step, the one every other control around
  // them is on. The drawer keeps the default step: there they are the primary
  // touch targets.
  const actionSize = isMobile ? 'medium' : 'small';

  const copyButton = (
    <Button
      variant="secondary"
      size={actionSize}
      onClick={() => void handleCopy()}
      disabled={exporting || !hasMessages}
    >
      {operation === 'copy' ? (
        <Spinner size="small" label={null} />
      ) : copied ? (
        <Check {...stylex.props(styles.glyph16)} />
      ) : (
        <Copy {...stylex.props(styles.glyph16)} />
      )}
      {operation === 'copy'
        ? t('sessions.shareImage.copying', 'Copying...')
        : t('sessions.shareImage.copyImage', 'Copy image')}
    </Button>
  );

  const exportButton = (
    <Button
      variant="primary"
      size={actionSize}
      onClick={() => void handleExport()}
      disabled={exporting || !hasMessages}
    >
      {operation === 'export' ? (
        <Spinner size="small" label={null} />
      ) : (
        <Download {...stylex.props(styles.glyph16)} />
      )}
      {operation === 'export'
        ? t('sessions.shareImage.exporting', 'Exporting...')
        : t('sessions.shareImage.exportPng', 'Export PNG')}
    </Button>
  );

  // Grouped by what they do to the image: the first row is its shape, the second
  // is its surface. The mat is inert without a ground, and stays visible while it
  // is — a control that vanishes on a swatch click relayouts the row under the
  // pointer.
  const shapeControls = (
    <>
      <DestinationToggle value={destination} onChange={chooseDestination} disabled={exporting} />
      <MatSlider value={mat} onChange={setMat} disabled={exporting || backdrop === 'none'} />
    </>
  );

  const surfaceControls = (
    <>
      <BackdropPicker value={backdrop} onChange={setBackdrop} disabled={exporting} />
      <PaletteToggle value={theme} onChange={setTheme} disabled={exporting} />
    </>
  );

  const requestOpenChange = (next: boolean) => {
    if (!exportingRef.current) onOpenChange(next);
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={requestOpenChange}>
        {/* The sheet's height is a layout constraint over the primitive's own cap. */}
        <DrawerContent style={{ height: '92dvh', maxHeight: '92dvh' }}>
          <div {...stylex.props(styles.drawerBody)}>
            <header {...stylex.props(styles.drawerHeader)}>
              <DrawerTitle className={stylex.props(styles.drawerTitle).className}>
                {dialogTitle}
              </DrawerTitle>
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="large"
                  icon
                  aria-label={t('common.close', 'Close')}
                  {...stylex.props(styles.drawerClose)}
                >
                  <X {...stylex.props(styles.glyphFill)} aria-hidden="true" />
                </Button>
              </DrawerClose>
            </header>
            <DrawerDescription className={stylex.props(styles.srOnly).className}>
              {t('sessions.shareImage.dialogDescription', 'PNG image')}
            </DrawerDescription>
            <div {...stylex.props(styles.preview, styles.drawerPreview)}>{preview}</div>
            <div {...stylex.props(styles.drawerControls)}>
              {status}
              <div {...stylex.props(styles.drawerRow)}>
                <DestinationToggle
                  value={destination}
                  onChange={chooseDestination}
                  disabled={exporting}
                />
              </div>
              <MatSlider
                value={mat}
                onChange={setMat}
                disabled={exporting || backdrop === 'none'}
              />
              <div {...stylex.props(styles.drawerRow)}>{surfaceControls}</div>
              <div {...stylex.props(styles.drawerActions)}>
                {copyButton}
                {exportButton}
              </div>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
      {/* The preview is the card at a readable scale, so the panel is wider than a
          dialog's column of prose. */}
      <Dialog.Content style={{ width: '720px' }}>
        <Dialog.Header>
          <Dialog.Title>{dialogTitle}</Dialog.Title>
          <Dialog.Description>
            {t('sessions.shareImage.dialogDescription', 'PNG image')}
          </Dialog.Description>
        </Dialog.Header>

        <div {...stylex.props(styles.preview)}>{preview}</div>

        {/* Controls above actions rather than one row: three fixed-width controls
            and two buttons do not share a line, and a status message sharing one
            would have to squeeze whatever is beside it. */}
        <div {...stylex.props(styles.controls)}>
          <div {...stylex.props(styles.controlRow)}>{shapeControls}</div>
          <div {...stylex.props(styles.controlRow)}>{surfaceControls}</div>
        </div>

        <Dialog.Footer className={stylex.props(styles.footer).className}>
          {status}
          {copyButton}
          {exportButton}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
