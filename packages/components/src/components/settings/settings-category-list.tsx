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

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
    paddingTop: space[3],
    paddingBottom: space[6],
  },
  groups: { display: 'flex', flexDirection: 'column', gap: '20px' },
  inset: { marginInline: space[3] },
  heading: {
    margin: 0,
    paddingInline: '20px',
    paddingBottom: space[1.5],
    fontSize: '0.82em',
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
    fontSize: '0.78em',
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
  const { t } = useTranslation();
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

  return (
    <FocusScope id={scopeId} {...stylex.props(styles.list)}>
      <div {...stylex.props(styles.groups)}>
        {accountTab ? (
          <div
            {...stylex.props(styles.inset)}
            data-id="settings:account"
            data-scope-item="row"
            data-settings-tab-id={accountTab.id}
          >
            <SettingsAccountEntry user={user} mobile onSelect={() => openCategory(accountTab)} />
          </div>
        ) : null}
        {SETTINGS_SECTIONS.map((section) => {
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
      </div>
      {canReportBug && (
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
