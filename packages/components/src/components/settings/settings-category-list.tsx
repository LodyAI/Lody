import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug, ChevronRight } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, space } from '@lody/ui/tokens/scales.stylex';
import { Card } from '@lody/ui/card';
import { useAtomValue, useSetAtom } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { bugReportDialogOpenAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAppCapability } from '@/lib/app-platform';
import { useOrganization } from '@/hooks/useOrganization';
import {
  useVisibleSettingsTabs,
  type SettingsTabConfig,
  type SettingsSectionId,
} from './settings-tabs';
import { SettingsAccountEntry } from './settings-account-entry';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { settingsSurface as surface } from './surface';
import { useMobileSettingsFold } from '@/components/mobile/mobile-settings-fold-context';
import { useOptionalSettingsDataCache } from './settings-data-cache';
import { formatCompactNumber, formatUsdTight } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { computeUsageShareModelSlices } from './usage-share-stats';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { WorkspaceAvatar } from '@/components/workspace-avatar';
import { resolveWorkspaceIdentityLogo } from '@/lib/workspace-identity';

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
    paddingTop: space[3],
    paddingBottom: space[6],
  },
  groups: { display: 'flex', flexDirection: 'column', gap: '20px' },
  foldList: { height: '100%', minHeight: 0, paddingTop: 0, paddingBottom: 0 },
  foldPanel: { minHeight: 0, overflowY: 'auto', paddingTop: space[3], paddingBottom: space[3] },
  foldLower: { flex: '1 1 0%' },
  foldAccountPanel: { display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  foldOverview: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
    alignItems: 'stretch',
    gap: space[3],
    marginInline: space[3],
  },
  foldAccount: { minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  foldAccountSingle: { gridTemplateColumns: 'minmax(0, 1fr)' },
  foldAccountFill: { height: '100%' },
  foldWorkspace: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[6],
    borderWidth: 0,
    borderInlineStart: '1px solid hsl(var(--border) / 0.65)',
    backgroundColor: 'transparent',
    color: colors.label,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'center',
  },
  foldWorkspaceText: { width: '100%', minWidth: 0 },
  foldWorkspaceName: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1.1em',
  },
  foldWorkspaceLabel: {
    display: 'block',
    marginTop: '2px',
    color: colors.secondaryLabel,
    fontSize: uiText.footnoteSize,
  },
  foldUsage: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    gap: space[1],
    padding: space[4],
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    borderWidth: 0,
    cursor: 'pointer',
  },
  foldUsageHeading: { display: 'flex', justifyContent: 'space-between', gap: space[2] },
  foldUsageLabel: {
    color: colors.secondaryLabel,
    fontSize: uiText.footnoteSize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  foldUsageValue: { fontSize: '1.5em', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  foldUsageCost: { color: colors.secondaryLabel, fontSize: uiText.footnoteSize },
  foldUsageVisuals: { display: 'flex', alignItems: 'end', gap: space[3], marginTop: space[2] },
  foldUsageModel: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    width: '44%',
    flexShrink: 0,
  },
  foldUsageRing: {
    position: 'relative',
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  foldUsageRingCenter: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    backgroundColor: colors.elevatedBackground,
  },
  foldUsageModelText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    fontSize: '10px',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
  foldUsageModelName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  foldUsageChartWrap: { minWidth: 0, flexGrow: 1 },
  foldUsageChart: {
    display: 'flex',
    alignItems: 'end',
    height: '52px',
    gap: '2px',
    borderBottom: '1px solid hsl(var(--border))',
    backgroundImage:
      'repeating-linear-gradient(to bottom, transparent 0, transparent calc(33.333% - 1px), hsl(var(--border) / 0.5) calc(33.333% - 1px), hsl(var(--border) / 0.5) 33.333%)',
  },
  foldUsageChartBar: {
    flex: '1 1 0%',
    minWidth: 0,
    borderTopLeftRadius: '2px',
    borderTopRightRadius: '2px',
    backgroundColor: 'hsl(var(--chart-1))',
  },
  foldUsageAxis: {
    display: 'flex',
    justifyContent: 'space-between',
    color: colors.tertiaryLabel,
    fontSize: '10px',
    lineHeight: 1,
  },
  inset: { marginInline: space[3] },
  heading: {
    margin: 0,
    paddingInline: '20px',
    paddingBottom: space[1.5],
    fontSize: uiText.footnoteSize,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  footer: { marginTop: 'auto', paddingTop: '20px' },
  /** A category is one line of the section's card; the whole line is the button. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    borderWidth: 0,
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
  },
  /** The whole line answers the pointer, and the finger on a phone. */
  rowPressed: {
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
      ':active': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 6%)`,
    },
  },
  /** The category's glyph, a hint at rest like every other icon in a row. */
  rowIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    color: colors.secondaryLabel,
  },
  glyph: { width: '18px', height: '18px' },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowLabel: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95em',
    fontWeight: 400,
    color: colors.label,
  },
  rowDescription: {
    margin: 0,
    marginTop: '2px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  chevron: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
  grid: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 640px)': 'repeat(2, minmax(0, 1fr))',
    },
    gap: space[4],
    padding: space[6],
  },
  gridButton: {
    display: 'block',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
  },
  gridCard: { height: '100%' },
  gridIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    color: colors.secondaryLabel,
  },
});

type SettingsCategoryListProps = {
  workspaceName?: string;
};

/* iOS-style grouped layout for the mobile settings list. Categories
   are bucketed into three sections so the surface reads as ordered
   rather than a single long undifferentiated list, mirroring the
   home Chat-tab grouping conventions (`MobileChatSectionHeading` +
   rounded card with inter-row dividers).

   The section grouping isn't load-bearing — re-order or re-bucket
   freely. The list still works if a tab id is missing from this map
   (we render whichever ids exist) or unknown to it (those fall into
   `misc`). */
const SETTINGS_SECTIONS: Array<{
  id: Exclude<SettingsSectionId, 'account'>;
  headingKey: string;
  defaultHeading: string;
}> = [
  {
    id: 'personal',
    headingKey: 'settings.sections.personal',
    defaultHeading: 'Personal',
  },
  {
    id: 'workspace',
    headingKey: 'settings.sections.workspace',
    defaultHeading: 'Workspace',
  },
  {
    id: 'other',
    headingKey: 'settings.sections.misc',
    defaultHeading: 'Other',
  },
];

export function SettingsCategoryList({ workspaceName }: SettingsCategoryListProps) {
  const { t, i18n } = useTranslation();
  const fold = useMobileSettingsFold();
  const usageAvailable = useAppCapability('usageAnalytics');
  const multiWorkspaceAvailable = useAppCapability('multiWorkspace');
  const settingsData = useOptionalSettingsDataCache();
  const weekUsage = usageAvailable ? settingsData?.usageTimelineByRange.week : undefined;
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const scopeId = useId();
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setBugReportDialogOpen = useSetAtom(bugReportDialogOpenAtom);
  const canReportBug = useAppCapability('bugReport');
  const { activeOrganization } = useOrganization();
  const user = useAtomValue(userAtom);
  const visibleTabs = useVisibleSettingsTabs({
    includeMultiMemberOnly: (activeOrganization?.members.length ?? 0) > 1,
  }).filter((tab) => tab.desktopOnly !== true);
  const resolvedWorkspaceName = workspaceName ?? workspaceSlug ?? null;
  const isNativeApp = isNativeAppShell();
  const accountTab = visibleTabs.find((tab) => tab.section === 'account') ?? null;
  const usageTab = visibleTabs.find((tab) => tab.id === 'ai-usage');
  const workspaceTab = visibleTabs.find((tab) => tab.id === 'workspace');
  const usageBuckets = weekUsage?.buckets ?? [];
  const dailyTokens = new Map<number, number>();
  for (const bucket of usageBuckets) {
    const dayStartMs = Math.floor(bucket.bucketStartMs / 86_400_000) * 86_400_000;
    dailyTokens.set(dayStartMs, (dailyTokens.get(dayStartMs) ?? 0) + bucket.tokens);
  }
  const usageDays = [...dailyTokens].sort(([a], [b]) => a - b);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const usageDates = usageDays.map(([day]) => dateFormatter.format(new Date(day)));
  const maxBucketTokens = usageDays.reduce((peak, [, tokens]) => Math.max(peak, tokens), 0);
  const modelSlices = usageBuckets.length
    ? computeUsageShareModelSlices(weekUsage, stripRecommended, t('workspace.usage.skyline.other'))
    : [];
  let modelPercent = 0;
  const modelGradient = modelSlices
    .map((slice, index) => {
      const start = modelPercent;
      modelPercent += slice.share * 100;
      return `hsl(var(--chart-${(index % 5) + 1})) ${start}% ${modelPercent}%`;
    })
    .join(', ');

  const openCategory = useCallback(
    (category: SettingsTabConfig) => {
      if (!resolvedWorkspaceName) return;
      void navigate({
        to: category.path,
        params: { workspaceName: resolvedWorkspaceName },
        search: (prev) => prev,
      });
    },
    [navigate, resolvedWorkspaceName]
  );
  const handleItemFocus = useCallback(
    (item: HTMLElement) => {
      const tabId = item.dataset.settingsTabId?.trim();
      const category = visibleTabs.find((tab) => tab.id === tabId);
      if (category) openCategory(category);
    },
    [openCategory, visibleTabs]
  );
  useListKeyboardNavigation({ onItemFocus: handleItemFocus, scopeId });

  if (!resolvedWorkspaceName) return null;

  const account = accountTab ? (
    <div
      {...stylex.props(fold ? styles.foldAccountFill : styles.inset)}
      data-id="settings:account"
      data-scope-item="row"
      data-settings-tab-id={accountTab.id}
    >
      <SettingsAccountEntry
        user={user}
        mobile
        hero={Boolean(fold)}
        embedded={Boolean(fold)}
        onSelect={() => openCategory(accountTab)}
      />
    </div>
  ) : null;
  const renderSections = (sections: typeof SETTINGS_SECTIONS) => (
    <>
      {sections.map((section) => {
        const sectionTabs = visibleTabs.filter(
          (tab) => tab.section === section.id && !(tab.id === 'billing' && isNativeApp)
        );
        if (sectionTabs.length === 0) return null;
        return (
          <section key={section.id} aria-label={t(section.headingKey, section.defaultHeading)}>
            <h2 {...stylex.props(styles.heading)}>
              {t(section.headingKey, section.defaultHeading)}
            </h2>
            <div {...stylex.props(surface.card, styles.inset)}>
              {sectionTabs.map((tab, index) => (
                <SettingsCategoryRow
                  key={tab.id}
                  tab={tab}
                  label={t(tab.labelKey)}
                  description={t(tab.descriptionKey)}
                  hasDivider={index > 0}
                  onSelect={() => openCategory(tab)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
  const footer = canReportBug && (
    <div {...stylex.props(styles.footer)}>
      <SettingsActionRow
        icon={Bug}
        label={t('bugReport.title', 'Report a bug')}
        description={t(
          'settings.bugReport.description',
          'Send a report with optional machine logs'
        )}
        onSelect={() => setBugReportDialogOpen(true)}
      />
    </div>
  );

  return (
    <FocusScope id={scopeId} {...stylex.props(styles.list, fold && styles.foldList)}>
      {fold ? (
        <>
          <div
            data-settings-fold-upper
            {...stylex.props(styles.foldPanel, styles.foldAccountPanel)}
            style={{ flex: `0 0 ${fold.messageHeight}px` }}
          >
            <div {...stylex.props(styles.foldOverview)}>
              <div
                {...stylex.props(
                  surface.card,
                  styles.foldAccount,
                  !account && styles.foldAccountSingle
                )}
              >
                {account}
                <button
                  type="button"
                  data-settings-fold-workspace
                  {...stylex.props(styles.foldWorkspace)}
                  disabled={!workspaceTab}
                  onClick={() => workspaceTab && openCategory(workspaceTab)}
                  aria-label={t('settings.tabs.workspaceGeneral')}
                >
                  <WorkspaceAvatar
                    workspace={{
                      name: activeOrganization?.name ?? resolvedWorkspaceName,
                      logo: resolveWorkspaceIdentityLogo(
                        activeOrganization?.logo,
                        multiWorkspaceAvailable
                      ),
                    }}
                    size="xlarge"
                  />
                  <span {...stylex.props(styles.foldWorkspaceText)}>
                    <span {...stylex.props(styles.foldWorkspaceName)}>
                      {activeOrganization?.name ?? resolvedWorkspaceName}
                    </span>
                    <span {...stylex.props(styles.foldWorkspaceLabel)}>
                      {t('settings.sections.workspace', 'Workspace')}
                    </span>
                  </span>
                </button>
              </div>
              <button
                type="button"
                {...stylex.props(surface.card, styles.foldUsage)}
                data-settings-fold-usage
                disabled={!usageTab}
                onClick={() => usageTab && openCategory(usageTab)}
              >
                <div {...stylex.props(styles.foldUsageHeading)}>
                  <span {...stylex.props(styles.foldUsageLabel)}>
                    {t('settings.sections.workspace', 'Workspace')}
                    {activeOrganization?.name ? ` · ${activeOrganization.name}` : null}
                  </span>
                  {usageTab ? (
                    <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
                  ) : null}
                </div>
                {usageAvailable ? (
                  <>
                    <div {...stylex.props(styles.foldUsageLabel)}>
                      {t('workspace.usage.window.week.long', 'Last 7 days')} ·{' '}
                      {t('workspace.usage.tokens')}
                    </div>
                    <div {...stylex.props(styles.foldUsageValue)}>
                      {weekUsage ? formatCompactNumber(weekUsage.totals.tokens, locale) : '—'}
                    </div>
                    <div {...stylex.props(styles.foldUsageCost)}>
                      {weekUsage
                        ? `${t('workspace.usage.cost')} · ${formatUsdTight(weekUsage.totals.costUSD, locale)}`
                        : settingsData?.workspaceId
                          ? t('workspace.usage.loading', 'Loading usage data...')
                          : t('workspace.usage.empty', 'No usage data in this range')}
                    </div>
                    {usageBuckets.length > 0 ? (
                      <>
                        <div {...stylex.props(styles.foldUsageVisuals)}>
                          {modelSlices.length ? (
                            <div {...stylex.props(styles.foldUsageModel)}>
                              <span
                                {...stylex.props(styles.foldUsageRing)}
                                style={{ background: `conic-gradient(${modelGradient})` }}
                                aria-hidden="true"
                              >
                                <span {...stylex.props(styles.foldUsageRingCenter)} />
                              </span>
                              <span {...stylex.props(styles.foldUsageModelText)}>
                                <span>{t('workspace.usage.byModel')}</span>
                                <span {...stylex.props(styles.foldUsageModelName)}>
                                  {modelSlices[0]?.label}
                                </span>
                                <span>{Math.round((modelSlices[0]?.share ?? 0) * 100)}%</span>
                              </span>
                            </div>
                          ) : null}
                          <div {...stylex.props(styles.foldUsageChartWrap)}>
                            <div
                              {...stylex.props(styles.foldUsageChart)}
                              aria-hidden="true"
                              data-settings-usage-chart
                            >
                              {usageDays.map(([dayStartMs, tokens]) => (
                                <span
                                  key={dayStartMs}
                                  {...stylex.props(styles.foldUsageChartBar)}
                                  style={{
                                    height: `${maxBucketTokens > 0 && tokens > 0 ? Math.max(7, (tokens / maxBucketTokens) * 100) : 0}%`,
                                    opacity: tokens > 0 ? 0.8 : 0,
                                  }}
                                />
                              ))}
                            </div>
                            <div {...stylex.props(styles.foldUsageAxis)} aria-hidden="true">
                              <span>{usageDates[0]}</span>
                              <span>{usageDates[Math.floor(usageDates.length / 2)]}</span>
                              <span>{usageDates.at(-1)}</span>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </>
                ) : null}
              </button>
            </div>
          </div>
          <div aria-hidden="true" style={{ flex: `0 0 ${fold.gapHeight}px` }} />
          <div data-settings-fold-lower {...stylex.props(styles.foldPanel, styles.foldLower)}>
            <div {...stylex.props(styles.groups)}>{renderSections(SETTINGS_SECTIONS)}</div>
            {footer}
          </div>
        </>
      ) : (
        <>
          <div {...stylex.props(styles.groups)}>
            {account}
            {renderSections(SETTINGS_SECTIONS)}
          </div>
          {footer}
        </>
      )}
    </FocusScope>
  );
}

function SettingsCategoryRow({
  tab,
  label,
  description,
  hasDivider,
  onSelect,
}: {
  tab: SettingsTabConfig;
  label: string;
  description: string;
  hasDivider: boolean;
  onSelect: () => void;
}) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      data-id={`settings:${tab.id}`}
      data-scope-item="row"
      data-settings-tab-id={tab.id}
      onClick={onSelect}
      {...stylex.props(styles.row, styles.rowPressed, hasDivider && surface.lineRuled)}
    >
      <span {...stylex.props(styles.rowIcon)}>
        <Icon {...stylex.props(styles.glyph)} aria-hidden="true" />
      </span>
      <div {...stylex.props(styles.rowText)}>
        <h3 {...stylex.props(styles.rowLabel)}>{label}</h3>
        <p {...stylex.props(styles.rowDescription)}>{description}</p>
      </div>
      <ChevronRight {...stylex.props(styles.chevron)} aria-hidden="true" />
    </button>
  );
}

function SettingsActionRow({
  icon: Icon,
  label,
  description,
  onSelect,
}: {
  icon: typeof Bug;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <div {...stylex.props(surface.card, styles.inset)}>
      <button
        type="button"
        data-id="settings:report-bug"
        data-scope-item="row"
        onClick={onSelect}
        {...stylex.props(styles.row, styles.rowPressed)}
      >
        <span {...stylex.props(styles.rowIcon)}>
          <Icon {...stylex.props(styles.glyph)} aria-hidden="true" />
        </span>
        <div {...stylex.props(styles.rowText)}>
          <h3 {...stylex.props(styles.rowLabel)}>{label}</h3>
          <p {...stylex.props(styles.rowDescription)}>{description}</p>
        </div>
      </button>
    </div>
  );
}

export function SettingsCategoryGrid() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const visibleTabs = useVisibleSettingsTabs();
  const categories = visibleTabs.map((tab) => ({
    ...tab,
    label: t(tab.labelKey),
    description: t(tab.descriptionKey),
  }));

  const openCategory = (category: SettingsTabConfig) => {
    if (!workspaceSlug) {
      return;
    }
    void navigate({
      to: category.path,
      params: { workspaceName: workspaceSlug },
      search: (prev) => prev,
    });
  };

  return (
    <div {...stylex.props(styles.grid)}>
      {workspaceSlug &&
        categories.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => openCategory(category)}
            {...stylex.props(styles.gridButton)}
          >
            <Card.Root interactive {...stylex.props(styles.gridCard)}>
              <span {...stylex.props(styles.gridIcon)}>
                <category.icon {...stylex.props(styles.glyph)} aria-hidden="true" />
              </span>
              <Card.Header>
                <Card.Title>{category.label}</Card.Title>
                <Card.Description>{category.description}</Card.Description>
              </Card.Header>
            </Card.Root>
          </button>
        ))}
    </div>
  );
}
