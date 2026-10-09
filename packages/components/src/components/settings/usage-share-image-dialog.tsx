import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePostHog } from '@posthog/react';
import * as stylex from '@stylexjs/stylex';
import { Check, Copy, Download } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
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

const styles = stylex.create({
  preview: {
    display: 'flex',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  previewFrame: { position: 'relative' },
  previewContent: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    width: 'max-content',
    transformOrigin: 'top left',
  },
  exportFrame: { width: 'max-content' },
  iconSize: { width: '16px', height: '16px' },
  body: {
    display: 'grid',
    minHeight: 0,
    flex: '1 1 0%',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 640px)': '280px minmax(0, 1fr)',
    },
  },
  controls: {
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
    padding: '16px',
    borderBottomWidth: {
      default: '1px',
      '@media (min-width: 640px)': '0px',
    },
    borderBottomStyle: 'solid',
    borderBottomColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    paddingInline: {
      default: null,
      '@media (min-width: 640px)': '20px',
    },
    borderRightWidth: {
      default: '0px',
      '@media (min-width: 640px)': '1px',
    },
    borderRightStyle: 'solid',
    borderRightColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
  },
  controlGroup: { marginBlockEnd: { default: '20px', ':last-child': 0 } },
  controlSpacing: { marginBlockEnd: { default: '8px', ':last-child': 0 } },
  hint: { fontSize: '0.75rem', lineHeight: '1.375', color: 'hsl(var(--muted-foreground))' },
  backdropGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '8px' },
  backdropNone: {
    gridColumn: '1 / -1',
    display: 'flex',
    height: '36px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    fontSize: '0.875rem',
    lineHeight: '20px',
    fontWeight: 400,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
  },
  backdropNoneSelected: {
    borderColor: 'hsl(var(--primary))',
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    color: 'hsl(var(--primary))',
    boxShadow: '0 0 0 2px color-mix(in oklab, hsl(var(--primary)) 25%, transparent)',
  },
  backdropNoneIdle: {
    borderColor: 'hsl(var(--border))',
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--muted)) 30%, transparent)',
      ':hover': 'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    },
  },
  backdropChoice: {
    position: 'relative',
    aspectRatio: '1',
    overflow: 'hidden',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    transitionProperty: 'box-shadow',
    transitionDuration: '150ms',
    boxShadow: {
      default: null,
      ':hover': '0 0 0 2px color-mix(in oklab, hsl(var(--primary)) 40%, transparent)',
    },
  },
  backdropChoiceSelected: {
    borderColor: 'hsl(var(--primary))',
    boxShadow: '0 0 0 2px hsl(var(--primary))',
  },
  backdropChoiceIdle: { borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)' },
  backdropCheck: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgb(0 0 0 / 15%)',
    color: 'white',
  },
  backdropCheckGlyph: { filter: 'drop-shadow(0 1px 1px rgb(0 0 0 / 25%))' },
  qrRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  previewPane: {
    minHeight: 0,
    padding: {
      default: '16px',
      '@media (min-width: 640px)': '24px',
    },
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
  },
  exportBar: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '12px',
    paddingBlock: '12px',
    paddingInline: {
      default: '16px',
      '@media (min-width: 640px)': '20px',
    },
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
  },
  status: { marginInlineEnd: 'auto', fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' },
  error: { color: 'hsl(var(--destructive))' },
});

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
    <div ref={containerRef} {...stylex.props(styles.preview)}>
      <div
        {...stylex.props(styles.previewFrame)}
        style={scaledSize ? { width: scaledSize.width, height: scaledSize.height } : undefined}
      >
        <div
          ref={contentRef}
          {...stylex.props(styles.previewContent)}
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
      <Dialog.Content
        width="56rem"
        style={{
          display: 'flex',
          maxHeight: '85vh',
          flexDirection: 'column',
          gap: 0,
          overflow: 'hidden',
          padding: 0,
        }}
      >
        <Dialog.Header className="border-b border-border/70 px-4 py-3.5 pr-12 text-left sm:px-5 sm:pr-12">
          <Dialog.Title className="text-base">
            {t('workspace.usage.shareImage.dialogTitle')}
          </Dialog.Title>
          <Dialog.Description className="leading-5">
            {t('workspace.usage.shareImage.dialogDescription')}
          </Dialog.Description>
        </Dialog.Header>

        <div {...stylex.props(styles.body)}>
          <fieldset disabled={exporting} {...stylex.props(styles.controls)}>
            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label
                className={stylex.props(styles.controlSpacing).className}
                htmlFor="usage-share-metric"
              >
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
                <Select.Trigger
                  id="usage-share-metric"
                  className={`w-full ${stylex.props(styles.controlSpacing).className}`}
                >
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="tokens">{t('workspace.usage.tokens')}</Select.Item>
                  <Select.Item value="costUSD">{t('workspace.usage.cost')}</Select.Item>
                </Select.Content>
              </Select.Root>
              {metric === 'costUSD' ? (
                <p {...stylex.props(styles.hint)}>
                  {t('workspace.usage.shareImage.metricCostHint')}
                </p>
              ) : null}
            </div>

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label
                className={stylex.props(styles.controlSpacing).className}
                htmlFor="usage-share-aspect"
              >
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
                <Select.Trigger
                  id="usage-share-aspect"
                  className={`w-full ${stylex.props(styles.controlSpacing).className}`}
                >
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

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label
                className={stylex.props(styles.controlSpacing).className}
                htmlFor="usage-share-subject"
              >
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
                <Select.Trigger
                  id="usage-share-subject"
                  className={`w-full ${stylex.props(styles.controlSpacing).className}`}
                >
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
                <p {...stylex.props(styles.hint)}>
                  {t('workspace.usage.shareImage.subjectTeamHint')}
                </p>
              ) : null}
            </div>

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label
                className={stylex.props(styles.controlSpacing).className}
                htmlFor="usage-share-theme"
              >
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
                <Select.Trigger
                  id="usage-share-theme"
                  className={`w-full ${stylex.props(styles.controlSpacing).className}`}
                >
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

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label
                className={stylex.props(styles.controlSpacing).className}
                htmlFor="usage-share-footer"
              >
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
                <Select.Trigger
                  id="usage-share-footer"
                  className={`w-full ${stylex.props(styles.controlSpacing).className}`}
                >
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

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label className={stylex.props(styles.controlSpacing).className}>
                {t('workspace.usage.shareImage.backdrop')}
              </UiField.Label>
              <div {...stylex.props(styles.backdropGrid)} role="group">
                <button
                  type="button"
                  aria-pressed={backdrop === 'none'}
                  {...stylex.props(
                    styles.backdropNone,
                    backdrop === 'none' ? styles.backdropNoneSelected : styles.backdropNoneIdle
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
                      {...stylex.props(
                        styles.backdropChoice,
                        selected ? styles.backdropChoiceSelected : styles.backdropChoiceIdle,
                        USAGE_SHARE_BACKDROP_STYLES[value]
                      )}
                      onClick={() => setBackdrop(value)}
                    >
                      {selected ? (
                        <span {...stylex.props(styles.backdropCheck)}>
                          <Check
                            size={16}
                            className={stylex.props(styles.backdropCheckGlyph).className}
                          />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div {...stylex.props(styles.controlGroup)}>
              <UiField.Label className={stylex.props(styles.controlSpacing).className}>
                {t('workspace.usage.shareImage.content')}
              </UiField.Label>
              <div {...stylex.props(styles.qrRow)}>
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

          <div {...stylex.props(styles.previewPane)}>
            <FitPreview>
              <div ref={exportRef} {...stylex.props(styles.exportFrame)}>
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

        <div {...stylex.props(styles.exportBar)}>
          {exportError ? (
            <p role="alert" {...stylex.props(styles.status, styles.error)}>
              {t('workspace.usage.shareImage.exportFailed')}
            </p>
          ) : copied ? (
            <p role="status" {...stylex.props(styles.status)}>
              {t('workspace.usage.shareImage.copied')}
            </p>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => void run('copy')}
            disabled={exporting || !assetsReady}
          >
            {operation === 'copy' ? (
              <Spinner size="small" />
            ) : copied ? (
              <Check className={stylex.props(styles.iconSize).className} />
            ) : (
              <Copy className={stylex.props(styles.iconSize).className} />
            )}
            {t('workspace.usage.shareImage.copyImage')}
          </Button>
          <Button onClick={() => void run('export')} disabled={exporting || !assetsReady}>
            {operation === 'export' ? (
              <Spinner size="small" />
            ) : (
              <Download className={stylex.props(styles.iconSize).className} />
            )}
            {t('workspace.usage.shareImage.exportPng')}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
