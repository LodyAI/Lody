import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, X } from 'lucide-react';
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
import { copyShareImage, exportShareImage } from '@/lib/share-image-export';
import { ChatShareCard, type ChatShareCardFormat } from '@/components/chat-share-card';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';

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

/** Two-state palette switch — the preview's only control. */
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
   * Overrides the device-derived card format. Stories use it to show both
   * forms; the product never passes it.
   */
  formatOverride?: ChatShareCardFormat;
}

/**
 * Preview and export for "Share as image". The card is a fixed template, so
 * this surface is a preview with one control (light or dark) and two actions,
 * not an editor: the phone form and the desktop form are chosen by the device
 * being shared from, and everything else about the image is already decided.
 *
 * The same preview and actions render in a bottom drawer on a handset and in a
 * dialog on a desktop.
 */
export function ChatShareImageDialog({
  open,
  onOpenChange,
  session,
  messages,
  agentName,
  formatOverride,
}: ChatShareImageDialogProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const format: ChatShareCardFormat = formatOverride ?? (isMobile ? 'phone' : 'desktop');
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
      await exportShareImage(exportRef.current, session?.title, 'lody-conversation');
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
      setCopied(true);
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
          format={format}
          theme={theme}
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

  const copyButton = (
    <Button
      variant="outline"
      onClick={() => void handleCopy()}
      disabled={exporting || !hasMessages}
    >
      {operation === 'copy' ? (
        <Spinner className="size-4" />
      ) : copied ? (
        <Check className="size-4" />
      ) : (
        <Copy className="size-4" />
      )}
      {operation === 'copy'
        ? t('sessions.shareImage.copying', 'Copying...')
        : t('sessions.shareImage.copyImage', 'Copy image')}
    </Button>
  );

  const exportButton = (
    <Button onClick={() => void handleExport()} disabled={exporting || !hasMessages}>
      {operation === 'export' ? <Spinner className="size-4" /> : <Download className="size-4" />}
      {operation === 'export'
        ? t('sessions.shareImage.exporting', 'Exporting...')
        : t('sessions.shareImage.exportPng', 'Export PNG')}
    </Button>
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
              <div className="flex justify-center">
                <PaletteToggle value={theme} onChange={setTheme} disabled={exporting} />
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

        <div className="flex shrink-0 items-center gap-3 border-t border-border/70 px-5 py-3">
          <PaletteToggle value={theme} onChange={setTheme} disabled={exporting} />
          <div className="ml-auto flex items-center gap-3">
            {status}
            {copyButton}
            {exportButton}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
