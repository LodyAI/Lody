import { useCallback, useId } from 'react';
import { Bug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtom, useSetAtom } from 'jotai';
import {
  bugReportDialogOpenAtom,
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAppCapability } from '@/lib/app-platform';
import { useOrganization } from '@/hooks/useOrganization';
import { useStableSession } from '@/hooks/useStableSession';
import { SettingsDataCacheProvider } from './settings-data-cache';
import {
  useVisibleSettingsTabs,
  type SettingsSectionId,
  type SettingsTabId,
} from './settings-tabs';
import { SettingsAccountEntry } from './settings-account-entry';
import { GeneralSettingsComponent } from './general-setting';
import { AppearanceSettingsComponent } from './appearance-setting';
import { AccountSettingsComponent } from './account-setting';
import { BillingSettingsComponent } from './billing-setting';
import { StatsSettingsComponent } from './stats-setting';
import { ProjectSettingsComponent } from './project-settings';
import { MachineAgentSettings } from './machine-agent-settings';
import { IntegrationsSettingsComponent } from './integrations-setting';
import { KeyboardShortcutsSetting } from './keyboard-shortcuts-setting';
import { AboutSettingsComponent } from './about-setting';
import { AgentRolesSetting } from './agent-roles-setting';
import { McpSetting } from './mcp-setting';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

/**
 * Desktop-only settings overlay. Mounted once at the app level (like the bug-report
 * dialog) and shown whenever `settingsDialogOpenAtom` is set on a non-mobile viewport.
 * It renders the same per-tab setting components that the route-based settings page
 * uses, so behavior stays in sync; mobile keeps the full-page route instead.
 */
export function DesktopSettingsModal() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useAtom(settingsDialogOpenAtom);

  // Never mount the modal tree on mobile — that path uses the route-based page.
  if (isMobile) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent
        noAnimation
        className="flex h-[min(90vh,950px)] w-[84vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:p-0"
      >
        <SettingsModalBody />
      </DialogContent>
    </Dialog>
  );
}

function SettingsModalBody() {
  const { t } = useTranslation();
  const navigationScopeId = useId();
  const contentScopeId = useId();
  const [activeTab, setActiveTab] = useAtom(settingsActiveTabAtom);
  const setSelectedMachineId = useSetAtom(settingsSelectedMachineIdAtom);
  const setSelectedProjectKey = useSetAtom(settingsSelectedProjectKeyAtom);
  const setBugReportDialogOpen = useSetAtom(bugReportDialogOpenAtom);
  const canReportBug = useAppCapability('bugReport');
  const { activeOrganization } = useOrganization();
  const { data: session } = useStableSession();
  const platformTabs = useVisibleSettingsTabs();
  const visibleTabs = isNativeAppShell()
    ? platformTabs.filter((tab) => tab.id !== 'billing')
    : platformTabs;
  const navigationTabs = visibleTabs.filter(
    (tab) => !tab.multiMemberOnly || (activeOrganization?.members.length ?? 0) > 1
  );

  const handleReportBug = useCallback(() => {
    setBugReportDialogOpen(true);
  }, [setBugReportDialogOpen]);

  const activeTabConfig = visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0];
  const resolvedActiveTab = activeTabConfig.id;
  const accountTab = visibleTabs.find((tab) => tab.section === 'account') ?? null;
  const selectTab = useCallback(
    (tabId: SettingsTabId) => {
      setSelectedMachineId(null);
      setSelectedProjectKey(null);
      setActiveTab(tabId);
    },
    [setActiveTab, setSelectedMachineId, setSelectedProjectKey]
  );
  const handleNavigationItemFocus = useCallback(
    (item: HTMLElement) => {
      const tabId = item.dataset.settingsTabId?.trim();
      if (tabId) selectTab(tabId as SettingsTabId);
    },
    [selectTab]
  );
  useListKeyboardNavigation({
    onItemFocus: handleNavigationItemFocus,
    scopeId: navigationScopeId,
  });
  const groupedSections: Array<{
    id: Exclude<SettingsSectionId, 'account'>;
    label: string;
  }> = [
    { id: 'personal', label: t('settings.sections.personal', 'Personal') },
    { id: 'workspace', label: t('settings.sections.workspace', 'Workspace') },
    { id: 'other', label: t('settings.sections.misc', 'Other') },
  ];
  // These tabs render their own in-content header (title + per-tab actions like
  // "add project"), so we drop the chrome title to avoid showing it twice.
  const selfTitledTab =
    resolvedActiveTab === 'projects' ||
    resolvedActiveTab === 'machines' ||
    resolvedActiveTab === 'agents';
  const usesInternalScrolling = resolvedActiveTab === 'projects';

  return (
    <SettingsDataCacheProvider>
      <DialogDescription className="sr-only">{t('settings.title')}</DialogDescription>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <FocusScope
          id={navigationScopeId}
          role="navigation"
          aria-label={t('settings.title')}
          className="flex w-60 flex-col border-e bg-background"
        >
          <nav className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-4">
              {groupedSections.map((section) => {
                const tabs = navigationTabs.filter((tab) => tab.section === section.id);
                const showsAccountEntry = section.id === 'personal' && accountTab;
                if (tabs.length === 0 && !showsAccountEntry) return null;
                return (
                  <section key={section.id} aria-label={section.label}>
                    <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground/55">
                      {section.label}
                    </h2>
                    <div className="space-y-0.5">
                      {showsAccountEntry ? (
                        <div
                          data-id="settings:account"
                          data-scope-item="row"
                          data-settings-tab-id="account"
                        >
                          <SettingsAccountEntry
                            user={session?.user}
                            active={resolvedActiveTab === 'account'}
                            onSelect={() => selectTab('account')}
                          />
                        </div>
                      ) : null}
                      {tabs.map((tab) => {
                        const Icon = tab.icon;
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            aria-current={resolvedActiveTab === tab.id ? 'page' : undefined}
                            data-id={`settings:${tab.id}`}
                            data-scope-item="row"
                            data-settings-tab-id={tab.id}
                            className={cn(
                              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-start text-sm font-medium transition-colors',
                              resolvedActiveTab === tab.id
                                ? 'bg-secondary text-secondary-foreground'
                                : 'text-muted-foreground hover:bg-secondary/50 hover:text-secondary-foreground'
                            )}
                            onClick={() => selectTab(tab.id)}
                          >
                            <Icon
                              className="h-4 w-4 shrink-0 opacity-80"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 truncate">{t(tab.labelKey)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </nav>
          {canReportBug && (
            <div className="mt-auto p-3">
              <button
                type="button"
                data-id="settings:report-bug"
                data-scope-item="row"
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1 text-start text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-secondary-foreground"
                onClick={handleReportBug}
              >
                <Bug className="h-4 w-4 shrink-0 opacity-80" strokeWidth={1.75} />
                {t('bugReport.title', 'Report a bug')}
              </button>
            </div>
          )}
        </FocusScope>

        <FocusScope
          id={contentScopeId}
          role="main"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {selfTitledTab ? (
            <DialogTitle className="sr-only">{t(activeTabConfig.labelKey)}</DialogTitle>
          ) : (
            <header className="mt-2 flex h-12 shrink-0 items-center px-8">
              <DialogTitle className="text-xl font-semibold leading-none">
                {t(activeTabConfig.labelKey)}
              </DialogTitle>
            </header>
          )}
          <div className="min-h-0 flex-1">
            {usesInternalScrolling ? (
              <div className="h-full px-6 pb-6 pt-6">
                <div className="mx-auto h-full max-w-5xl">
                  <SettingsTabContent tabId={resolvedActiveTab} />
                </div>
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className={cn('px-6 pb-6', selfTitledTab ? 'pt-6' : 'pt-0')}>
                  <div className="mx-auto max-w-5xl">
                    <SettingsTabContent tabId={resolvedActiveTab} />
                  </div>
                </div>
              </ScrollArea>
            )}
          </div>
        </FocusScope>
      </div>
    </SettingsDataCacheProvider>
  );
}

function SettingsTabContent({ tabId }: { tabId: SettingsTabId }) {
  // Mobile routes keep the machine in URL search. The modal uses a shared atom
  // so Account shortcuts can select a machine before switching tabs.
  const [selectedMachineId, setSelectedMachineId] = useAtom(settingsSelectedMachineIdAtom);

  switch (tabId) {
    case 'preferences':
      return <GeneralSettingsComponent />;
    case 'appearance':
      return <AppearanceSettingsComponent />;
    case 'account':
      return <AccountSettingsComponent surface="account" />;
    case 'workspace':
      return <AccountSettingsComponent surface="workspace" />;
    case 'people':
      return <AccountSettingsComponent surface="workspace" />;
    case 'billing':
      return <BillingSettingsComponent />;
    case 'ai-usage':
      return <StatsSettingsComponent />;
    case 'projects':
      return <ProjectSettingsComponent />;
    case 'agents':
      return (
        <MachineAgentSettings
          mode="agents"
          selectedMachineId={selectedMachineId}
          onSelectedMachineChange={setSelectedMachineId}
        />
      );
    case 'agent-roles':
      return <AgentRolesSetting />;
    case 'mcp':
      return <McpSetting />;
    case 'machines':
      return (
        <MachineAgentSettings
          mode="machines"
          selectedMachineId={selectedMachineId}
          onSelectedMachineChange={setSelectedMachineId}
        />
      );
    case 'github':
      return <IntegrationsSettingsComponent />;
    case 'keyboard-shortcuts':
      return <KeyboardShortcutsSetting />;
    case 'about':
      return <AboutSettingsComponent />;
  }

  const exhaustive: never = tabId;
  return exhaustive;
}
