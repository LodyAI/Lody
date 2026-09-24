import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import { Check, Copy, Download } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { cn } from '@/lib/utils';
import { Dialog } from '@/ui/dialog';
import { Field as UiField } from '@lody/ui/field';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
import { Select } from '@lody/ui/select';
import { copyShareImage, exportShareImage } from '@/lib/share-image-export';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { createUsageCalendarModel, type UsageCalendarMetric } from './usage-calendar-model';
import {
  UsageShareCard,
  USAGE_SHARE_BACKDROP_STYLES,
  type UsageShareCardAspect,
  type UsageShareCardBackdrop,
  type UsageShareCardFooter,
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
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
    >
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
  const postHog = usePostHog();
  const [aspect, setAspect] = useState<UsageShareCardAspect>('portrait');
  const [subject, setSubject] = useState<UsageShareCardSubject>('personal');
  const [backdrop, setBackdrop] = useState<UsageShareCardBackdrop>('lody');
  const [theme, setTheme] = useState<'app' | 'light' | 'dark'>('dark');
  const [footer, setFooter] = useState<UsageShareCardFooter>('card');
  const [metric, setMetric] = useState<UsageCalendarMetric>('tokens');
  const [showQr, setShowQr] = useState(true);
  const exportRef = useRef<HTMLDivElement>(null);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<'copy' | 'export' | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [copied, setCopied] = useState(false);

  // The heatmap's own intensity scale is built from the same metric the card is
  // denominated in, so a cost card is shaded by cost rather than by tokens.
  const model = useMemo(() => createUsageCalendarModel(calendar, metric), [calendar, metric]);
  const stats = useMemo(
    () => computeUsageShareStats(model, timeline, range, metric),
    [model, timeline, range, metric]
  );
  const graphic = useMemo(
    () => computeUsageShareGraphic(timeline, range, metric),
    [timeline, range, metric]
  );
  const modelSlices = useMemo(
    () =>
      computeUsageShareModelSlices(
        timeline,
        stripRecommended,
        t('workspace.usage.skyline.other'),
        metric
      ),
    [timeline, t, metric]
  );
  const memberSlices = useMemo(
    () =>
      computeUsageShareMemberSlices(
        timeline,
        () => t('workspace.usage.shareImage.unknownMember'),
        t('workspace.usage.skyline.other'),
        metric
      ),
    [timeline, t, metric]
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
      const orientation = aspect === 'wide' ? 'landscape' : 'portrait';
      if (operationKind === 'copy') {
        await copyShareImage(exportRef.current);
        capturePostHogEvent(postHog, 'export/usage_image_created', {
          orientation,
          action: 'copied',
        });
        setCopied(true);
      } else {
        const { saved } = await exportShareImage(
          exportRef.current,
          workspaceName ? `${workspaceName} usage` : undefined,
          'lody-usage'
        );
        if (saved)
          capturePostHogEvent(postHog, 'export/usage_image_created', {
            orientation,
            action: 'saved',
          });
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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!exportingRef.current) onOpenChange(next);
      }}
    >
      <Dialog.Content className="flex max-h-[85vh] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:p-0">
        <Dialog.Header className="border-b border-border/70 px-4 py-3.5 pr-12 text-left sm:px-5 sm:pr-12">
          <Dialog.Title className="text-base">
            {t('workspace.usage.shareImage.dialogTitle')}
          </Dialog.Title>
          <Dialog.Description className="leading-5">
            {t('workspace.usage.shareImage.dialogDescription')}
          </Dialog.Description>
        </Dialog.Header>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[280px_minmax(0,1fr)]">
          <fieldset
            disabled={exporting}
            className="min-h-0 min-w-0 space-y-5 overflow-y-auto border-b border-border/70 px-4 py-4 sm:border-b-0 sm:border-r sm:px-5"
          >
            <div className="space-y-2">
              <UiField.Label htmlFor="usage-share-metric">
                {t('workspace.usage.shareImage.metric')}
              </UiField.Label>
              <Select.Root
                items={[
                  { value: 'tokens', label: t('workspace.usage.tokens') },
                  { value: 'costUSD', label: t('workspace.usage.cost') },
                ]}
                value={metric}
                onValueChange={(value) => {
                  if (value != null) setMetric(value as UsageCalendarMetric);
                }}
              >
                <Select.Trigger id="usage-share-metric" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="tokens">{t('workspace.usage.tokens')}</Select.Item>
                  <Select.Item value="costUSD">{t('workspace.usage.cost')}</Select.Item>
                </Select.Content>
              </Select.Root>
              {metric === 'costUSD' ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  {t('workspace.usage.shareImage.metricCostHint')}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <UiField.Label htmlFor="usage-share-aspect">
                {t('workspace.usage.shareImage.aspect')}
              </UiField.Label>
              <Select.Root
                items={[
                  {
                    value: 'portrait',
                    label: t('workspace.usage.shareImage.aspectPortrait'),
                  },
                  { value: 'wide', label: t('workspace.usage.shareImage.aspectWide') },
                ]}
                value={aspect}
                onValueChange={(value) => {
                  if (value != null) setAspect(value as UsageShareCardAspect);
                }}
              >
                <Select.Trigger id="usage-share-aspect" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="portrait">
                    {t('workspace.usage.shareImage.aspectPortrait')}
                  </Select.Item>
                  <Select.Item value="wide">
                    {t('workspace.usage.shareImage.aspectWide')}
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            <div className="space-y-2">
              <UiField.Label htmlFor="usage-share-subject">
                {t('workspace.usage.shareImage.subject')}
              </UiField.Label>
              <Select.Root
                items={[
                  {
                    value: 'personal',
                    label: t('workspace.usage.shareImage.subjectPersonal'),
                  },
                  { value: 'team', label: t('workspace.usage.shareImage.subjectTeam') },
                ]}
                value={subject}
                onValueChange={(value) => {
                  if (value != null) setSubject(value as UsageShareCardSubject);
                }}
              >
                <Select.Trigger id="usage-share-subject" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="personal">
                    {t('workspace.usage.shareImage.subjectPersonal')}
                  </Select.Item>
                  <Select.Item value="team" disabled={!teamAvailable}>
                    {t('workspace.usage.shareImage.subjectTeam')}
                  </Select.Item>
                </Select.Content>
              </Select.Root>
              {subject === 'team' ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  {t('workspace.usage.shareImage.subjectTeamHint')}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <UiField.Label htmlFor="usage-share-theme">
                {t('workspace.usage.shareImage.theme')}
              </UiField.Label>
              <Select.Root
                items={[
                  { value: 'app', label: t('workspace.usage.shareImage.themeApp') },
                  { value: 'light', label: t('workspace.usage.shareImage.themeLight') },
                  { value: 'dark', label: t('workspace.usage.shareImage.themeDark') },
                ]}
                value={theme}
                onValueChange={(value) => {
                  if (value != null) setTheme(value as 'app' | 'light' | 'dark');
                }}
              >
                <Select.Trigger id="usage-share-theme" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="app">{t('workspace.usage.shareImage.themeApp')}</Select.Item>
                  <Select.Item value="light">
                    {t('workspace.usage.shareImage.themeLight')}
                  </Select.Item>
                  <Select.Item value="dark">
                    {t('workspace.usage.shareImage.themeDark')}
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            <div className="space-y-2">
              <UiField.Label htmlFor="usage-share-footer">
                {t('workspace.usage.shareImage.footer')}
              </UiField.Label>
              <Select.Root
                items={[
                  { value: 'card', label: t('workspace.usage.shareImage.footerCard') },
                  { value: 'canvas', label: t('workspace.usage.shareImage.footerCanvas') },
                ]}
                value={footer}
                onValueChange={(value) => {
                  if (value != null) setFooter(value as UsageShareCardFooter);
                }}
                disabled={backdrop === 'none'}
              >
                <Select.Trigger id="usage-share-footer" className="w-full">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="card">
                    {t('workspace.usage.shareImage.footerCard')}
                  </Select.Item>
                  <Select.Item value="canvas">
                    {t('workspace.usage.shareImage.footerCanvas')}
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </div>

            <div className="space-y-2">
              <UiField.Label>{t('workspace.usage.shareImage.backdrop')}</UiField.Label>
              <div className="grid grid-cols-4 gap-2" role="group">
                <button
                  type="button"
                  aria-pressed={backdrop === 'none'}
                  className={cn(
                    'col-span-full flex h-9 items-center justify-center rounded-md border text-sm font-normal transition-colors',
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
              <UiField.Label>{t('workspace.usage.shareImage.content')}</UiField.Label>
              <div className="flex items-center justify-between gap-3">
                <UiField.Label
                  htmlFor="usage-share-qr"
                  className="font-normal text-muted-foreground"
                >
                  {t('workspace.usage.shareImage.showQr')}
                </UiField.Label>
                <Switch id="usage-share-qr" checked={showQr} onCheckedChange={setShowQr} />
              </div>
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
                  footer={footer}
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
            variant="secondary"
            onClick={() => void run('copy')}
            disabled={exporting || !assetsReady}
          >
            {operation === 'copy' ? (
              <Spinner className="size-4" />
            ) : copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {t('workspace.usage.shareImage.copyImage')}
          </Button>
          <Button onClick={() => void run('export')} disabled={exporting || !assetsReady}>
            {operation === 'export' ? (
              <Spinner className="size-4" />
            ) : (
              <Download className="size-4" />
            )}
            {t('workspace.usage.shareImage.exportPng')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
