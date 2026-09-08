import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';
import { estimateTokenCount, type SessionMeta, type ConversationMessage } from '@lody/shared';
import { formatCompactNumber } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Label } from '@/ui/label';
import { Input } from '@/ui/input';
import { Button } from '@/ui/button';
import { exportChatShareImage } from '@/lib/chat-share-image-export';
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
  const [assetsReady, setAssetsReady] = useState(false);
  const [exportError, setExportError] = useState(false);

  const handleExport = async () => {
    if (!exportRef.current || exportingRef.current || !assetsReady) return;
    exportingRef.current = true;
    setExporting(true);
    setExportError(false);
    try {
      await exportChatShareImage(exportRef.current, session?.title);
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
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
              <Label htmlFor="chat-share-backdrop">
                {t('sessions.shareImage.backdrop', 'Background')}
              </Label>
              <Select
                value={backdrop}
                onValueChange={(value) => setBackdrop(value as ChatShareCardBackdrop)}
              >
                <SelectTrigger id="chat-share-backdrop" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BACKDROPS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'none' ? t('sessions.shareImage.backdropNone', 'None') : value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Label className="mb-1">{t('sessions.shareImage.content', 'Content')}</Label>
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
              <Label className="mb-1">{t('sessions.shareImage.code', 'Code')}</Label>
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
                'Could not export the image. Please try again.'
              )}
            </p>
          ) : null}
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || !assetsReady || messages.length === 0}
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {exporting
              ? t('sessions.shareImage.exporting', 'Exporting...')
              : t('sessions.shareImage.exportPng', 'Export PNG')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
