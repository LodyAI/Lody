import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Label } from '@/ui/label';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { copyShareImage, exportShareImage } from '@/lib/share-image-export';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { createUsageCalendarModel } from './usage-calendar-model';
import {
  UsageShareCard,
  USAGE_SHARE_BACKDROP_STYLES,
  type UsageShareCardAspect,
  type UsageShareCardBackdrop,
  type UsageShareCardSubject,
} from './usage-share-card';
import {
  computeUsageShareGraphic,
  computeUsageShareMemberSlices,
  computeUsageShareModelSlices,
  computeUsageShareStats,
} from './usage-share-stats';
import type {
  SettingsUsageCalendarData,
  SettingsUsageRange,
  SettingsUsageTimelineData,
} from './settings-data-cache';

const BACKDROPS: Exclude<UsageShareCardBackdrop, 'none'>[] = ['lody', 'aurora', 'ocean', 'sunset'];

/**
 * Scales the fixed-size card down to the preview panel. The card never reflows —
 * its whole point is that the exported pixels are the same every time — so the
 * preview only transforms it.
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
      if (!width || !height || !container.clientWidth || !container.clientHeight) return;
      const next = Math.min(1, container.clientWidth / width, container.clientHeight / height);
      setScale(next);
      setScaledSize({ width: width * next, height: height * next });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        className="relative"
        style={scaledSize ? { width: scaledSize.width, height: scaledSize.height } : undefined}
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

export interface UsageShareImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendar: SettingsUsageCalendarData;
  /** Timeline for the range the stats page is showing; drives every number. */
  timeline?: SettingsUsageTimelineData;
  range: SettingsUsageRange;
  workspaceName?: string;
}

/**
 * Preview and export for the workspace usage card. The session share dialog is
 * an editor with nine knobs because its content has no fixed shape; this one is
 * a generator with five, because its content does — the fewer choices, the more
 * two months' cards can be read against each other.
 */
export function UsageShareImageDialog({
  open,
  onOpenChange,
  calendar,
  timeline,
  range,
  workspaceName,
}: UsageShareImageDialogProps) {
  const { t } = useTranslation();
  const [aspect, setAspect] = useState<UsageShareCardAspect>('portrait');
  const [subject, setSubject] = useState<UsageShareCardSubject>('personal');
  const [backdrop, setBackdrop] = useState<UsageShareCardBackdrop>('lody');
  const [theme, setTheme] = useState<'app' | 'light' | 'dark'>('dark');
  const [showCost, setShowCost] = useState(false);
  const [showQr, setShowQr] = useState(true);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<'copy' | 'export' | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);

  // The card is always token-denominated; the page's cost/tokens toggle is an
  // on-screen reading aid, not a property of the shared image.
  const model = useMemo(() => createUsageCalendarModel(calendar, 'tokens'), [calendar]);
  const stats = useMemo(
    () => computeUsageShareStats(model, timeline, range),
    [model, timeline, range]
  );
  const graphic = useMemo(() => computeUsageShareGraphic(timeline, range), [timeline, range]);
  const modelSlices = useMemo(
    () =>
      computeUsageShareModelSlices(timeline, stripRecommended, t('workspace.usage.skyline.other')),
    [timeline, t]
  );
  const memberSlices = useMemo(
    () =>
      computeUsageShareMemberSlices(
        timeline,
        () => t('workspace.usage.shareImage.unknownMember'),
        t('workspace.usage.skyline.other')
      ),
    [timeline, t]
  );

  // A "team" card that lists one person is just the personal card with a worse
  // label, so the mode only opens once the range actually has two contributors.
  const teamAvailable = memberSlices.length > 1;
  useEffect(() => {
    if (!teamAvailable && subject === 'team') setSubject('personal');
  }, [teamAvailable, subject]);

  const run = async (operationKind: 'copy' | 'export') => {
    if (!exportRef.current || exportingRef.current || !assetsReady) return;
    exportingRef.current = true;
    setExporting(true);
    setOperation(operationKind);
    setExportError(false);
    setCopied(false);
    try {
      if (operationKind === 'copy') {
        await copyShareImage(exportRef.current);
        setCopied(true);
      } else {
        await exportShareImage(
          exportRef.current,
          workspaceName ? `${workspaceName} usage` : undefined,
          'lody-usage'
        );
      }
    } catch {
      setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setOperation(null);
    }
  };

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
            {t('workspace.usage.shareImage.dialogTitle')}
          </DialogTitle>
          <DialogDescription className="leading-5">
            {t('workspace.usage.shareImage.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[280px_minmax(0,1fr)]">
          <fieldset
            disabled={exporting}
            className="min-h-0 min-w-0 space-y-5 overflow-y-auto border-b border-border/70 px-4 py-4 sm:border-b-0 sm:border-r sm:px-5"
          >
            <div className="space-y-2">
              <Label htmlFor="usage-share-aspect">{t('workspace.usage.shareImage.aspect')}</Label>
              <Select
                value={aspect}
                onValueChange={(value) => setAspect(value as UsageShareCardAspect)}
              >
                <SelectTrigger id="usage-share-aspect" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">
                    {t('workspace.usage.shareImage.aspectPortrait')}
                  </SelectItem>
                  <SelectItem value="wide">
                    {t('workspace.usage.shareImage.aspectWide')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="usage-share-subject">{t('workspace.usage.shareImage.subject')}</Label>
              <Select
                value={subject}
                onValueChange={(value) => setSubject(value as UsageShareCardSubject)}
              >
                <SelectTrigger id="usage-share-subject" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">
                    {t('workspace.usage.shareImage.subjectPersonal')}
                  </SelectItem>
                  <SelectItem value="team" disabled={!teamAvailable}>
                    {t('workspace.usage.shareImage.subjectTeam')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {subject === 'team' ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  {t('workspace.usage.shareImage.subjectTeamHint')}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="usage-share-theme">{t('workspace.usage.shareImage.theme')}</Label>
              <Select
                value={theme}
                onValueChange={(value) => setTheme(value as 'app' | 'light' | 'dark')}
              >
                <SelectTrigger id="usage-share-theme" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">{t('workspace.usage.shareImage.themeApp')}</SelectItem>
                  <SelectItem value="light">
                    {t('workspace.usage.shareImage.themeLight')}
                  </SelectItem>
                  <SelectItem value="dark">{t('workspace.usage.shareImage.themeDark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t('workspace.usage.shareImage.backdrop')}</Label>
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
                  {t('workspace.usage.shareImage.backdropNone')}
                </button>
                {BACKDROPS.map((value) => {
                  const selected = backdrop === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-label={value}
                      aria-pressed={selected}
                      className={cn(
                        'relative aspect-square overflow-hidden rounded-md border transition-shadow hover:ring-2 hover:ring-primary/40',
                        selected ? 'border-primary ring-2 ring-primary' : 'border-border/70'
                      )}
                      style={USAGE_SHARE_BACKDROP_STYLES[value]}
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
              <Label>{t('workspace.usage.shareImage.content')}</Label>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="usage-share-cost" className="font-normal text-muted-foreground">
                  {t('workspace.usage.shareImage.showCost')}
                </Label>
                <Switch id="usage-share-cost" checked={showCost} onCheckedChange={setShowCost} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="usage-share-qr" className="font-normal text-muted-foreground">
                  {t('workspace.usage.shareImage.showQr')}
                </Label>
                <Switch id="usage-share-qr" checked={showQr} onCheckedChange={setShowQr} />
              </div>
              {showCost ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  {t('workspace.usage.shareImage.showCostHint')}
                </p>
              ) : null}
            </div>
          </fieldset>

          <div className="min-h-0 bg-muted/40 p-4 sm:p-6">
            <FitPreview>
              <div ref={exportRef} className="w-fit">
                <UsageShareCard
                  calendar={model}
                  stats={stats}
                  graphic={graphic}
                  modelSlices={modelSlices}
                  memberSlices={memberSlices}
                  rangeLabel={t(`workspace.usage.window.${range}.long`)}
                  workspaceName={workspaceName}
                  aspect={aspect}
                  subject={subject}
                  backdrop={backdrop}
                  showCost={showCost}
                  showQr={showQr}
                  theme={theme === 'app' ? undefined : theme}
                  onAssetsReadyChange={setAssetsReady}
                />
              </div>
            </FitPreview>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 px-4 py-3 sm:px-5">
          {exportError ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {t('workspace.usage.shareImage.exportFailed')}
            </p>
          ) : copied ? (
            <p role="status" className="mr-auto text-sm text-muted-foreground">
              {t('workspace.usage.shareImage.copied')}
            </p>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void run('copy')}
            disabled={exporting || !assetsReady}
          >
            {operation === 'copy' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {t('workspace.usage.shareImage.copyImage')}
          </Button>
          <Button onClick={() => void run('export')} disabled={exporting || !assetsReady}>
            {operation === 'export' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {t('workspace.usage.shareImage.exportPng')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
