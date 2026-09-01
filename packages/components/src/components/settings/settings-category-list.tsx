import { useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/ui/card';
import { useAtomValue, useSetAtom } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { bugReportDialogOpenAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { isNativeAppShell } from '@/lib/native-platform';
import { cn } from '@/lib/utils';
import { useAppCapability } from '@/lib/app-platform';
import { useOrganization } from '@/hooks/useOrganization';
import {
  useVisibleSettingsTabs,
  type SettingsTabConfig,
  type SettingsSectionId,
} from './settings-tabs';
import { SettingsAccountEntry } from './settings-account-entry';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

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
  });
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
    <FocusScope id={scopeId} className="flex min-h-full flex-col pb-6 pt-3">
      <div className="flex flex-col gap-5">
        {accountTab ? (
          <div
            className="mx-3"
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
              <h2 className="px-5 pb-1.5 text-[0.82rem] font-semibold text-muted-foreground">
                {t(section.headingKey, section.defaultHeading)}
              </h2>
              <div className="mx-3 overflow-hidden rounded-2xl border border-border/60 bg-card">
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
        <div className="mt-auto pt-5">
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
      className={cn(
        'block w-full text-left transition-colors active:bg-muted/40',
        hasDivider && 'border-t border-border'
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Icon plate matches the home screen's avatar treatment —
           rounded primary-tinted square + icon in the primary color
           so the settings rows feel like the same family as the home
           Chat / Projects rows. */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Icon className="h-[1.05rem] w-[1.05rem] text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[0.95rem] font-medium text-foreground">{label}</h3>
          <p className="mt-0.5 truncate text-[0.78rem] text-muted-foreground">{description}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      </div>
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
    <div className="mx-3 overflow-hidden rounded-2xl border border-border/60 bg-card">
      <button
        type="button"
        data-id="settings:report-bug"
        data-scope-item="row"
        onClick={onSelect}
        className="block w-full text-left transition-colors active:bg-muted/40"
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Icon className="h-[1.05rem] w-[1.05rem] text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[0.95rem] font-medium text-foreground">{label}</h3>
            <p className="mt-0.5 truncate text-[0.78rem] text-muted-foreground">{description}</p>
          </div>
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
    <div className="p-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {workspaceSlug &&
          categories.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => openCategory(category)}
              className="block text-left"
            >
              <Card className="h-full hover:bg-hover transition-colors cursor-pointer">
                <CardContent className="p-6">
                  <div className="flex flex-col gap-3">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <category.icon className="h-6 w-6 text-primary" />
                    </div>

                    <div>
                      <h3 className="font-semibold text-lg mb-1">{category.label}</h3>
                      <p className="text-sm text-muted-foreground">{category.description}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
      </div>
    </div>
  );
}
