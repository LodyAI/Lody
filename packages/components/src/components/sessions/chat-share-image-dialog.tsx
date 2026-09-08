import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { estimateTokenCount, type SessionMeta, type ConversationMessage } from '@lody/shared';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Label } from '@/ui/label';
import { Input } from '@/ui/input';
import { Button } from '@/ui/button';
import { copyChatShareImage, exportChatShareImage } from '@/lib/chat-share-image-export';
import { Switch } from '@/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import {
  ChatShareCard,
  type ChatShareCardBackdrop,
  type ChatShareCardFooterVariant,
} from '@/components/chat-share-card';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';

const BACKDROPS: ChatShareCardBackdrop[] = ['none', 'lody', 'aurora', 'ocean', 'sunset'];
const FOOTER_VARIANTS: ChatShareCardFooterVariant[] = [
  'stacked',
  'row',
  'minimal',
  'canvas',
  'exif',
];

const BACKDROP_SWATCHES: Record<Exclude<ChatShareCardBackdrop, 'none'>, string> = {
  lody: 'radial-gradient(52% 38% at 18% 12%, rgba(53,200,176,0.45), transparent 70%), radial-gradient(48% 36% at 86% 16%, rgba(47,119,191,0.5), transparent 70%), radial-gradient(70% 55% at 68% 96%, rgba(31,79,127,0.65), transparent 75%), linear-gradient(165deg, #0a1c2b 0%, #0c2438 55%, #081626 100%)',
  aurora: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)',
  ocean: 'linear-gradient(135deg, #0369a1 0%, #0891b2 50%, #34d399 100%)',
  sunset: 'linear-gradient(135deg, #9a3412 0%, #ea580c 45%, #f59e0b 100%)',
};

/** EXIF sub line: fixed `YYYY-MM-DD HH:mm` regardless of product language. */
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
    <div ref={containerRef} className="h-full w-full overflow-y-auto overflow-x-hidden">
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

export interface ChatShareImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Session the card is captured from; drives the EXIF footer meta. */
  session: SessionMeta | null;
  /**
   * Messages to render, already filtered by the caller. Round selection is a
   * chat-surface interaction (IM-style multi-select), not part of this dialog.
   */
  messages: ConversationMessage[];
  /** Custom Runtime's configured display name. */
  agentName?: string;
}

/**
 * Preview/config dialog for "Share as image". Renders a live `ChatShareCard`
 * with a compact style panel and exports the complete card as PNG.
 */
export function ChatShareImageDialog({
  open,
  onOpenChange,
  session,
  messages,
  agentName,
}: ChatShareImageDialogProps) {
  const { t, i18n } = useTranslation();
  const intlLocale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const modelName = messages.findLast((message) => message.role === 'assistant')?.modelName;
  const selectedTokenCount = useMemo(
    () =>
      messages.reduce(
        (total, message) => total + (message.estimatedTokens ?? estimateTokenCount(message.text)),
        0
      ),
    [messages]
  );
  const [backdrop, setBackdrop] = useState<ChatShareCardBackdrop>('lody');
  const [framePadding, setFramePadding] = useState<'compact' | 'regular' | 'spacious'>('regular');
  const [theme, setTheme] = useState<'app' | 'light' | 'dark'>('app');
  const [footerVariant, setFooterVariant] = useState<ChatShareCardFooterVariant>('exif');
  const [showQr, setShowQr] = useState(true);
  const [showTitle, setShowTitle] = useState(true);
  const [showDate, setShowDate] = useState(true);
  const [wrapCode, setWrapCode] = useState(false);
  const [collapseAfter, setCollapseAfter] = useState(0);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<'copy' | 'export' | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleExport = async () => {
    if (!exportRef.current || exportingRef.current || !assetsReady) return;
    exportingRef.current = true;
    setExporting(true);
    setOperation('export');
    setExportError(false);
    try {
      await exportChatShareImage(exportRef.current, session?.title);
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setOperation(null);
    }
  };

  const handleCopy = async () => {
    if (!exportRef.current || exportingRef.current || !assetsReady) return;
    exportingRef.current = true;
    setExporting(true);
    setOperation('copy');
    setExportError(false);
    setCopied(false);
    try {
      await copyChatShareImage(exportRef.current);
      setCopied(true);
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setOperation(null);
    }
  };

  const qrAvailable =
    footerVariant === 'stacked' || footerVariant === 'row' || footerVariant === 'canvas';

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
      title: runtimeName ?? 'Lody',
      params,
      sub: showDate ? formatShareImageDate(session?.createdAt) : undefined,
      icon:
        session?.cliType && session.agentType ? (
          <AgentIcon cliType={session.cliType} agentType={session.agentType} className="size-5" />
        ) : undefined,
    };
  }, [session, agentName, modelName, showDate, selectedTokenCount, intlLocale, t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!exportingRef.current) onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:p-0">
        <DialogHeader className="border-b border-border/70 px-4 py-3.5 pr-12 text-left sm:px-5 sm:pr-12">
          <DialogTitle className="text-base">
            {t('sessions.shareImage.dialogTitle', 'Share as image')}
          </DialogTitle>
          <DialogDescription className="leading-5">
            {t('sessions.shareImage.dialogDescription', 'PNG image')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[320px_minmax(0,1fr)]">
          <fieldset
            disabled={exporting}
            className="min-h-0 min-w-0 space-y-5 overflow-y-auto border-b border-border/70 px-4 py-4 sm:border-b-0 sm:border-r sm:px-5"
          >
            <div className="space-y-2">
              <Label htmlFor="chat-share-theme">{t('sessions.shareImage.theme', 'Theme')}</Label>
              <Select
                value={theme}
                onValueChange={(value) => setTheme(value as 'app' | 'light' | 'dark')}
              >
                <SelectTrigger id="chat-share-theme" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">
                    {t('sessions.shareImage.themeApp', 'Follow app')}
                  </SelectItem>
                  <SelectItem value="light">
                    {t('sessions.shareImage.themeLight', 'Light')}
                  </SelectItem>
                  <SelectItem value="dark">{t('sessions.shareImage.themeDark', 'Dark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t('sessions.shareImage.backdrop', 'Background')}</Label>
              <div className="grid grid-cols-4 gap-2" role="group">
                <button
                  type="button"
                  aria-pressed={backdrop === 'none'}
                  className={cn(
                    'col-span-full flex h-9 items-center justify-center rounded-md border text-sm font-medium transition-colors',
                    backdrop === 'none'
                      ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/25'
                      : 'border-border bg-muted/30 hover:bg-muted/60'
                  )}
                  onClick={() => setBackdrop('none')}
                >
                  {t('sessions.shareImage.backdropNone', 'None')}
                </button>
                {BACKDROPS.filter(
                  (value): value is Exclude<ChatShareCardBackdrop, 'none'> => value !== 'none'
                ).map((value) => {
                  const selected = backdrop === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-label={t(
                        `sessions.shareImage.backdrop${value[0].toUpperCase()}${value.slice(1)}`,
                        value
                      )}
                      aria-pressed={selected}
                      className={cn(
                        'relative aspect-square overflow-hidden rounded-md border transition-shadow hover:ring-2 hover:ring-primary/40',
                        selected ? 'border-primary ring-2 ring-primary' : 'border-border/70'
                      )}
                      style={{ background: BACKDROP_SWATCHES[value] }}
                      onClick={() => setBackdrop(value)}
                    >
                      {selected ? (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/15 text-white">
                          <Check className="size-4 drop-shadow" />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chat-share-padding">
                {t('sessions.shareImage.framePadding', 'Backdrop padding')}
              </Label>
              <Select
                value={framePadding}
                onValueChange={(value) =>
                  setFramePadding(value as 'compact' | 'regular' | 'spacious')
                }
                disabled={backdrop === 'none'}
              >
                <SelectTrigger id="chat-share-padding" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">
                    {t('sessions.shareImage.paddingCompact', 'Compact')}
                  </SelectItem>
                  <SelectItem value="regular">
                    {t('sessions.shareImage.paddingRegular', 'Regular')}
                  </SelectItem>
                  <SelectItem value="spacious">
                    {t('sessions.shareImage.paddingSpacious', 'Spacious')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chat-share-footer">{t('sessions.shareImage.footer', 'Footer')}</Label>
              <Select
                value={footerVariant}
                onValueChange={(value) => setFooterVariant(value as ChatShareCardFooterVariant)}
              >
                <SelectTrigger id="chat-share-footer" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOOTER_VARIANTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="mb-2 block">{t('sessions.shareImage.content', 'Content')}</Label>
              <div className="flex items-center justify-between gap-3">
                <Label
                  htmlFor="chat-share-show-title"
                  className="font-normal text-muted-foreground"
                >
                  {t('sessions.shareImage.showTitle', 'Session title')}
                </Label>
                <Switch
                  id="chat-share-show-title"
                  checked={showTitle}
                  onCheckedChange={setShowTitle}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="chat-share-show-date" className="font-normal text-muted-foreground">
                  {t('sessions.shareImage.showDate', 'Date (EXIF footer)')}
                </Label>
                <Switch
                  id="chat-share-show-date"
                  checked={showDate}
                  onCheckedChange={setShowDate}
                  disabled={footerVariant !== 'exif'}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="chat-share-show-qr" className="font-normal text-muted-foreground">
                  {t('sessions.shareImage.showQr', 'QR code')}
                </Label>
                <Switch
                  id="chat-share-show-qr"
                  checked={showQr}
                  onCheckedChange={setShowQr}
                  disabled={!qrAvailable}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="mb-2 block">{t('sessions.shareImage.code', 'Code')}</Label>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="chat-share-wrap" className="font-normal text-muted-foreground">
                  {t('sessions.shareImage.wrapLines', 'Wrap long lines')}
                </Label>
                <Switch id="chat-share-wrap" checked={wrapCode} onCheckedChange={setWrapCode} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="chat-share-collapse" className="font-normal text-muted-foreground">
                  {t('sessions.shareImage.collapseAfter', 'Collapse code blocks after (lines)')}
                </Label>
                <Input
                  id="chat-share-collapse"
                  type="number"
                  min={0}
                  value={collapseAfter}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setCollapseAfter(Number.isFinite(next) && next > 0 ? next : 0);
                  }}
                />
              </div>
            </div>
          </fieldset>

          <div className="min-h-0 bg-muted/40 p-4 sm:p-6">
            {messages.length > 0 ? (
              <FitPreview>
                <div ref={exportRef} className="w-fit">
                  <ChatShareCard
                    onAssetsReadyChange={setAssetsReady}
                    messages={messages}
                    title={showTitle ? session?.title?.trim() || undefined : undefined}
                    backdrop={backdrop}
                    framePadding={framePadding}
                    footerVariant={footerVariant}
                    showQr={showQr}
                    theme={theme === 'app' ? undefined : theme}
                    code={{ wrap: wrapCode, collapseAfter }}
                    meta={meta}
                  />
                </div>
              </FitPreview>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t('sessions.shareImage.empty', 'No conversation to share')}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 px-4 py-3 sm:px-5">
          {exportError ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {t(
                'sessions.shareImage.exportFailed',
                'Could not complete the image action. Please try again.'
              )}
            </p>
          ) : copied ? (
            <p role="status" className="mr-auto text-sm text-muted-foreground">
              {t('sessions.shareImage.copied', 'Image copied to clipboard')}
            </p>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void handleCopy()}
            disabled={exporting || !assetsReady || messages.length === 0}
          >
            {operation === 'copy' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {operation === 'copy'
              ? t('sessions.shareImage.copying', 'Copying...')
              : t('sessions.shareImage.copyImage', 'Copy image')}
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || !assetsReady || messages.length === 0}
          >
            {operation === 'export' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {operation === 'export'
              ? t('sessions.shareImage.exporting', 'Exporting...')
              : t('sessions.shareImage.exportPng', 'Export PNG')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
