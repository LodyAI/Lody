import { useCallback, useId, type CSSProperties } from 'react';
import { Bug, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { useAtom, useSetAtom } from 'jotai';
import {
  bugReportDialogOpenAtom,
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import { ScrollArea } from '@/ui';
import { Dialog } from '@/ui/dialog';
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
import { PromptShortcutsSetting } from './prompt-shortcuts-setting';
import { McpSetting } from './mcp-setting';
import { ShareManagementSetting } from './share-management-setting';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

/**
 * The overlay's own size. The dialog panel sets its width, padding and gap
 * itself, so a class could not reliably win over them; `style` is the panel's
 * documented way to take a surface's layout.
 */
const PANEL_STYLE: CSSProperties = {
  width: '84vw',
  maxWidth: '1100px',
  height: 'min(90vh, 950px)',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
};

/** The close button's inset, equal from the top and the end of the right pane. */
const CLOSE_INSET = space[2];

const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  body: {
    display: 'flex',
    flexGrow: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  /** The nav: its fill (`surface.nav`) is what splits it from the page. */
  nav: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '240px',
  },
  navScroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: space[3],
  },
  navGroupHeading: {
    margin: 0,
    paddingInline: space[2],
    paddingBottom: space[1],
    fontSize: type.caption,
    fontWeight: 400,
    lineHeight: type.leading,
    color: colors.tertiaryLabel,
  },
  navGroupRows: { display: 'flex', flexDirection: 'column', gap: '2px' },
  navFooter: { marginTop: 'auto', padding: space[3] },
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  close: {
    position: 'absolute',
    insetBlockStart: CLOSE_INSET,
    insetInlineEnd: CLOSE_INSET,
    zIndex: 10,
  },
  closeGlyph: { width: '100%', height: '100%' },
  surface: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    paddingTop: '20px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    height: '40px',
  },
  /**
   * The title sits in the same centred column as the page under it, inset like
   * a row, so it starts where the section text does at any pane width.
   */
  headerFlush: { paddingBottom: 0 },
  headerColumn: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '760px',
    marginInline: 'auto',
    paddingInline: space[6],
  },
  paneBody: { flexGrow: 1, minHeight: 0 },
  fill: { height: '100%' },
  /**
   * `padding-inline-end` keeps every right-pane control off the close button's
   * column (inset + button). It sits inside the scroll area so the scrollbar
   * stays flush with the pane edge.
   */
  paneInset: {
    paddingInlineStart: space[6],
    paddingInlineEnd: '40px',
    paddingBottom: space[6],
  },
  paneInsetTop: { paddingTop: space[6] },
  paneColumn: { marginInline: 'auto', maxWidth: '1024px' },
});
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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <Dialog.Content noAnimation closeButton={false} style={PANEL_STYLE}>
        <SettingsModalBody />
      </Dialog.Content>
    </Dialog.Root>
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
      <Dialog.Description {...stylex.props(styles.srOnly)}>
        {t('settings.title')}
      </Dialog.Description>
      <div {...stylex.props(styles.body)}>
        <FocusScope
          id={navigationScopeId}
          role="navigation"
          aria-label={t('settings.title')}
          {...stylex.props(styles.nav, surface.nav)}
        >
          <nav {...stylex.props(styles.navScroll)}>
            {groupedSections.map((section) => {
              const tabs = navigationTabs.filter((tab) => tab.section === section.id);
              const showsAccountEntry = section.id === 'personal' && accountTab;
              if (tabs.length === 0 && !showsAccountEntry) return null;
              return (
                <section key={section.id} aria-label={section.label}>
                  <h2 {...stylex.props(styles.navGroupHeading)}>{section.label}</h2>
                  <div {...stylex.props(styles.navGroupRows)}>
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
                      const active = resolvedActiveTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          data-id={`settings:${tab.id}`}
                          data-scope-item="row"
                          data-settings-tab-id={tab.id}
                          {...stylex.props(surface.listRow, active && surface.listRowSelected)}
                          onClick={() => selectTab(tab.id)}
                        >
                          <Icon
                            {...stylex.props(
                              surface.listRowIcon,
                              active && surface.listRowIconSelected
                            )}
                            strokeWidth={1.75}
                            aria-hidden="true"
                          />
                          <span {...stylex.props(surface.listRowLabel)}>{t(tab.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </nav>
          {canReportBug && (
            <div {...stylex.props(styles.navFooter)}>
              <button
                type="button"
                data-id="settings:report-bug"
                data-scope-item="row"
                {...stylex.props(surface.listRow)}
                onClick={handleReportBug}
              >
                <Bug {...stylex.props(surface.listRowIcon)} strokeWidth={1.75} />
                <span {...stylex.props(surface.listRowLabel)}>
                  {t('bugReport.title', 'Report a bug')}
                </span>
              </button>
            </div>
          )}
        </FocusScope>

        <FocusScope id={contentScopeId} role="main" {...stylex.props(styles.content)}>
          <Dialog.Close
            render={
              <Button
                variant="ghost"
                size="mini"
                icon
                aria-label={t('common.close', 'Close')}
                {...stylex.props(styles.close)}
              />
            }
          >
            <X {...stylex.props(styles.closeGlyph)} aria-hidden="true" />
          </Dialog.Close>
          <div {...stylex.props(styles.surface, surface.canvas)} data-settings-surface="">
            {selfTitledTab ? (
              <Dialog.Title {...stylex.props(styles.srOnly)}>
                {t(activeTabConfig.labelKey)}
              </Dialog.Title>
            ) : (
              <header {...stylex.props(styles.header, styles.paneInset, styles.headerFlush)}>
                <div {...stylex.props(styles.headerColumn)}>
                  {/* The dialog's title style would tie with this one on the same
                    element; the page title's size lives on its own box. */}
                  <Dialog.Title>
                    <span {...stylex.props(surface.pageTitle)}>{t(activeTabConfig.labelKey)}</span>
                  </Dialog.Title>
                </div>
              </header>
            )}
            <div {...stylex.props(styles.paneBody)}>
              {usesInternalScrolling ? (
                <div {...stylex.props(styles.fill, styles.paneInset, styles.paneInsetTop)}>
                  <div {...stylex.props(styles.fill, styles.paneColumn)}>
                    <SettingsTabContent tabId={resolvedActiveTab} />
                  </div>
                </div>
              ) : (
                <ScrollArea {...stylex.props(styles.fill)}>
                  <div {...stylex.props(styles.paneInset, selfTitledTab && styles.paneInsetTop)}>
                    <div {...stylex.props(styles.paneColumn)}>
                      <SettingsTabContent tabId={resolvedActiveTab} />
                    </div>
                  </div>
                </ScrollArea>
              )}
            </div>
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
    case 'prompt-shortcuts':
      return <PromptShortcutsSetting />;
    case 'mcp':
      return <McpSetting />;
    case 'shares':
      return <ShareManagementSetting />;
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
