import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { Check, Copy, Download, Slash, X } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { estimateTokenCount, type SessionMeta, type ConversationMessage } from '@lody/shared';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useResolvedTheme } from '@/theme-provider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@/ui/button';
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
    <div ref={containerRef} className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden">
      <div
        className="relative mx-auto"
        style={
          scaledSize
            ? { width: scaledSize.width, height: scaledSize.height }
            : { width: 'fit-content' }
        }
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 w-fit origin-top-left"
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
      className="inline-grid h-9 grid-cols-2 rounded-full border border-border/70 bg-muted/60 p-0.5"
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
            className={cn(
              'flex min-w-16 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              'disabled:pointer-events-none disabled:opacity-60',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
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
    <div className="flex items-center gap-2">
      <span
        id="chat-share-destination-label"
        className={cn(
          'shrink-0 text-xs text-muted-foreground transition-opacity',
          disabled && 'opacity-60'
        )}
      >
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="chat-share-destination-label"
        className="inline-grid h-9 grid-cols-2 rounded-full border border-border/70 bg-muted/60 p-0.5"
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
              className={cn(
                'flex min-w-14 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                'disabled:pointer-events-none disabled:opacity-60',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
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
      className="flex items-center gap-1.5"
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
            className={cn(
              'relative size-7 shrink-0 overflow-hidden rounded-md border transition-shadow',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              'disabled:pointer-events-none disabled:opacity-60',
              selected
                ? 'border-primary ring-2 ring-primary'
                : 'border-border/70 hover:ring-2 hover:ring-primary/40'
            )}
            style={backdrop === 'none' ? undefined : CHAT_SHARE_BACKDROP_STYLES[backdrop]}
          >
            {backdrop === 'none' ? (
              <Slash
                className="absolute inset-0 m-auto size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            ) : null}
            {selected ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/15 text-white">
                <Check className="size-3.5 drop-shadow" aria-hidden="true" />
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
    <div className={cn('flex min-w-52 flex-1 items-center gap-3', disabled && 'opacity-60')}>
      <span id="chat-share-mat-label" className="shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <Slider
        aria-labelledby="chat-share-mat-label"
        min={MIN_MAT}
        max={MAX_MAT}
        step={MAT_STEP}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        className="min-w-24 flex-1"
      />
      <span className="w-7 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {value}
      </span>
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
          <AgentIcon cliType={session.cliType} agentType={session.agentType} className="size-5" />
        ) : undefined,
    };
  }, [session, agentName, modelName, selectedTokenCount, intlLocale, t]);

  const hasMessages = messages.length > 0;
  const dialogTitle = t('sessions.shareImage.dialogTitle', 'Share as image');

  const preview = hasMessages ? (
    <FitPreview>
      <div ref={exportRef} className="w-fit">
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
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('sessions.shareImage.empty', 'No conversation to share')}
    </div>
  );

  const status = exportError ? (
    <p role="alert" className="text-sm text-destructive">
      {t(
        'sessions.shareImage.exportFailed',
        'Could not complete the image action. Please try again.'
      )}
    </p>
  ) : copied ? (
    <p role="status" className="text-sm text-muted-foreground">
      {t('sessions.shareImage.copied', 'Image copied to clipboard')}
    </p>
  ) : null;

  // `sm` is also `text-xs`, which every other control in this footer already uses:
  // at the default size the two buttons are the only `text-sm` thing in it. The
  // drawer keeps the default size instead — there they are the primary touch
  // targets, and `h-9` is already under the 44pt guidance without shrinking it.
  const actionSize = isMobile ? 'default' : 'sm';
  const iconSize = isMobile ? 'size-4' : 'size-3.5';

  const copyButton = (
    <Button
      variant="outline"
      size={actionSize}
      onClick={() => void handleCopy()}
      disabled={exporting || !hasMessages}
    >
      {operation === 'copy' ? (
        <Spinner className={iconSize} />
      ) : copied ? (
        <Check className={iconSize} />
      ) : (
        <Copy className={iconSize} />
      )}
      {operation === 'copy'
        ? t('sessions.shareImage.copying', 'Copying...')
        : t('sessions.shareImage.copyImage', 'Copy image')}
    </Button>
  );

  const exportButton = (
    <Button
      size={actionSize}
      onClick={() => void handleExport()}
      disabled={exporting || !hasMessages}
    >
      {operation === 'export' ? (
        <Spinner className={iconSize} />
      ) : (
        <Download className={iconSize} />
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
        <DrawerContent className="h-[92dvh]! max-h-[92dvh]! rounded-t-2xl border-border/60">
          <div className="flex h-full min-h-0 flex-col">
            <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
              <DrawerTitle className="mx-auto text-[0.95rem] font-semibold tracking-tight">
                {dialogTitle}
              </DrawerTitle>
              <DrawerClose asChild>
                <button
                  type="button"
                  aria-label={t('common.close', 'Close')}
                  className="absolute right-3 top-1.5 inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <X className="size-5" aria-hidden="true" strokeWidth={1.8} />
                </button>
              </DrawerClose>
            </header>
            <DrawerDescription className="sr-only">
              {t('sessions.shareImage.dialogDescription', 'PNG image')}
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col bg-muted/40 px-4 py-4">{preview}</div>
            <div className="shrink-0 space-y-3 border-t border-border/70 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
              {status}
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
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
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
                {surfaceControls}
              </div>
              <div className="grid grid-cols-2 gap-2 [&>button]:w-full">
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
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px] sm:p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-3.5 pr-12 text-left">
          <DialogTitle className="text-base">{dialogTitle}</DialogTitle>
          <DialogDescription className="leading-5">
            {t('sessions.shareImage.dialogDescription', 'PNG image')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col bg-muted/40 p-6">{preview}</div>

        {/* Controls above actions rather than one row: three fixed-width controls
            and two buttons do not share a line, and a status message sharing one
            would have to squeeze whatever is beside it. */}
        <div className="flex shrink-0 flex-col border-t border-border/70">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 pt-3">
            {shapeControls}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 pb-2.5 pt-3">
            {surfaceControls}
          </div>
          <div className="flex items-center gap-3 px-5 pb-3">
            {status}
            <div className="ml-auto flex shrink-0 items-center gap-3">
              {copyButton}
              {exportButton}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
