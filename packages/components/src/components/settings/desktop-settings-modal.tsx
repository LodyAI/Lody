import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Bug, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Tabs } from '@lody/ui/tabs';
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
import { productDarkPalette, productLightPalette } from '@/lib/vscode-theme/lody-ui-palette.stylex';
import { useResolvedTheme } from '@/theme-provider';
import { settingsFlat } from './material.stylex';
import { SettingsPaneHeaderProvider } from './settings-page-header';
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
  containerType: 'inline-size',
  containerName: 'desktop-settings',
};

// The 240px nav needs a readable page beside it; the panel is narrower than the window.
const NARROW = '@container desktop-settings (max-width: 720px)';

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
    flexDirection: { default: 'row', [NARROW]: 'column' },
    flexGrow: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  /** The nav: its fill (`surface.nav`) is what splits it from the page. */
  nav: {
    display: { default: 'flex', [NARROW]: 'none' },
    flexDirection: 'column',
    flexShrink: 0,
    width: '240px',
  },
  compactNav: {
    display: { default: 'none', [NARROW]: 'flex' },
    alignItems: 'center',
    gap: space[1],
    flexShrink: 0,
    paddingInline: space[2],
    paddingBlock: space[1],
  },
  compactNavViewport: {
    flexGrow: 1,
    minWidth: 0,
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  /**
   * One line of categories: the sidebar's sections become groups set apart by
   * space alone, so the strip keeps its order without gaining labels it has no
   * room for.
   */
  compactNavRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'stretch',
    gap: space[4],
    width: 'max-content',
    minWidth: '100%',
    paddingInline: space[1],
  },
  compactNavGroup: { display: 'flex', alignItems: 'stretch' },
  /**
   * A category on the strip: a word, not a key in a track. The pointer hints a
   * line in faint ink; the current one keeps it solid. Its bottom edge is the
   * strip's, so the line lands on the seam between navigation and page.
   */
  compactNavItem: {
    display: 'inline-flex',
    alignItems: 'center',
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[2],
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    boxShadow: {
      default: null,
      ':hover': `inset 0 -2px 0 color-mix(in oklab, transparent, ${colors.label} 20%)`,
      ':focus-visible': `inset 0 -2px 0 color-mix(in oklab, transparent, ${colors.label} 20%)`,
    },
    outlineStyle: 'none',
    color: {
      default: colors.secondaryLabel,
      ':hover': colors.label,
      ':focus-visible': colors.label,
    },
    fontFamily: 'inherit',
    fontSize: '1em',
    fontWeight: 400,
    lineHeight: type.leading,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  compactNavItemSelected: {
    color: {
      default: colors.label,
      ':hover': colors.label,
      ':focus-visible': colors.label,
    },
    boxShadow: {
      default: `inset 0 -2px 0 ${colors.label}`,
      ':hover': `inset 0 -2px 0 ${colors.label}`,
      ':focus-visible': `inset 0 -2px 0 ${colors.label}`,
    },
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
  header: { flexShrink: 0 },
  /** Page actions wrap below the title when the pane cannot fit both. */
  headerRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    minHeight: '40px',
  },
  headerTitle: { minWidth: 0, overflowWrap: 'anywhere' },
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    maxWidth: '100%',
    alignItems: 'center',
    gap: space[2],
  },
  /** The page's lead, under its name; empty on a page without one. */
  headerLead: {
    margin: 0,
    fontSize: type.caption,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
    ':empty': { display: 'none' },
  },
  /**
   * The title sits in the same centred column as the page under it, at the
   * edge its section trays start from, at any pane width.
   */
  headerFlush: { paddingBottom: 0 },
  headerColumn: {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '760px',
    marginInline: 'auto',
    paddingInline: { default: space[4], [NARROW]: 0 },
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
  const compactNavigationScopeId = useId();
  const contentScopeId = useId();
  const [activeTab, setActiveTab] = useAtom(settingsActiveTabAtom);
  const setSelectedMachineId = useSetAtom(settingsSelectedMachineIdAtom);
  const setSelectedProjectKey = useSetAtom(settingsSelectedProjectKeyAtom);
  const setBugReportDialogOpen = useSetAtom(bugReportDialogOpenAtom);
  const canReportBug = useAppCapability('bugReport');
  const { activeOrganization } = useOrganization();
  const { data: session } = useStableSession();
  const resolvedTheme = useResolvedTheme();
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
  useListKeyboardNavigation({
    onItemFocus: handleNavigationItemFocus,
    scopeId: compactNavigationScopeId,
  });
  /**
   * A horizontal strip moves on Left/Right — the keys the scope switcher would
   * otherwise claim. Up/Down, J/K and Home/End fall through to the scope's own
   * navigation above.
   */
  const handleCompactNavKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('[data-scope-item]')
      );
      if (items.length === 0) return;
      const active = document.activeElement;
      const current =
        active instanceof HTMLElement ? active.closest<HTMLElement>('[data-scope-item]') : null;
      const currentIndex = current ? items.indexOf(current) : -1;
      const nextIndex =
        event.key === 'ArrowRight'
          ? currentIndex < 0
            ? 0
            : currentIndex + 1
          : currentIndex < 0
            ? items.length - 1
            : currentIndex - 1;
      const next = items[(nextIndex + items.length) % items.length];
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      handleNavigationItemFocus(next);
    },
    [handleNavigationItemFocus]
  );
  const [navViewport, setNavViewport] = useState<HTMLDivElement | null>(null);
  const [navOverflow, setNavOverflow] = useState({ before: false, after: false });
  useLayoutEffect(() => {
    if (!navViewport) return undefined;
    const updateOverflow = () => {
      const before = navViewport.scrollLeft > 1;
      const after = navViewport.scrollLeft + navViewport.clientWidth < navViewport.scrollWidth - 1;
      setNavOverflow((previous) =>
        previous.before === before && previous.after === after ? previous : { before, after }
      );
    };
    const revealSelected = () => {
      const selected = navViewport.querySelector<HTMLElement>('[aria-current="page"]');
      if (selected && navViewport.clientWidth > 0) {
        const viewportBox = navViewport.getBoundingClientRect();
        const selectedBox = selected.getBoundingClientRect();
        // Scroll only this rail: scrollIntoView can also move the dialog's page.
        navViewport.scrollTo({
          left:
            navViewport.scrollLeft +
            selectedBox.left -
            viewportBox.left -
            (viewportBox.width - selectedBox.width) / 2,
        });
      }
      updateOverflow();
    };
    const observer = new ResizeObserver(revealSelected);
    observer.observe(navViewport);
    if (navViewport.firstElementChild) observer.observe(navViewport.firstElementChild);
    navViewport.addEventListener('scroll', updateOverflow);
    revealSelected();
    return () => {
      observer.disconnect();
      navViewport.removeEventListener('scroll', updateOverflow);
    };
  }, [navViewport, resolvedActiveTab, t]);
  /**
   * Overflow is said by the rail fading where more categories wait, not by
   * scroll buttons: the mask only fades an edge while that edge still hides
   * something.
   */
  const navMask = useMemo(() => {
    if (!navOverflow.before && !navOverflow.after) return undefined;
    const stops = [navOverflow.before ? 'transparent 0' : 'black 0'];
    if (navOverflow.before) stops.push('black 32px');
    if (navOverflow.after) stops.push('black calc(100% - 32px)');
    stops.push(navOverflow.after ? 'transparent 100%' : 'black 100%');
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [navOverflow]);
  const groupedSections: Array<{
    id: Exclude<SettingsSectionId, 'account'>;
    label: string;
  }> = [
    { id: 'personal', label: t('settings.sections.personal', 'Personal') },
    { id: 'workspace', label: t('settings.sections.workspace', 'Workspace') },
    { id: 'other', label: t('settings.sections.misc', 'Other') },
  ];
  /** The strip keeps the sidebar's order and grouping; the groups just lose their headings. */
  const compactNavGroups = [
    { id: 'account' as const, tabs: navigationTabs.filter((tab) => tab.section === 'account') },
    ...groupedSections.map((section) => ({
      id: section.id,
      tabs: navigationTabs.filter((tab) => tab.section === section.id),
    })),
  ].filter((group) => group.tabs.length > 0);
  const usesInternalScrolling = resolvedActiveTab === 'projects';
  // Every page's actions and lead are drawn in this one header.
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [leadSlot, setLeadSlot] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const headerSlots = useMemo(
    () => ({ actions: actionsSlot, lead: leadSlot, pane }),
    [actionsSlot, leadSlot, pane]
  );

  return (
    <SettingsDataCacheProvider>
      <Dialog.Description {...stylex.props(styles.srOnly)}>
        {t('settings.title')}
      </Dialog.Description>
      <Tabs.Root
        value={resolvedActiveTab}
        onValueChange={(value) => {
          if (value !== null) selectTab(value as SettingsTabId);
        }}
        render={<div style={{ display: 'contents' }} />}
      >
        <div {...stylex.props(styles.body)}>
          <FocusScope
            id={compactNavigationScopeId}
            role="navigation"
            aria-label={t('settings.title')}
            onKeyDown={handleCompactNavKeyDown}
            {...stylex.props(styles.compactNav, surface.nav)}
          >
            <div
              ref={setNavViewport}
              data-settings-nav-viewport=""
              {...stylex.props(styles.compactNavViewport)}
              style={{ maskImage: navMask, WebkitMaskImage: navMask }}
            >
              <div {...stylex.props(styles.compactNavRow)}>
                {compactNavGroups.map((group) => (
                  <div key={group.id} {...stylex.props(styles.compactNavGroup)}>
                    {group.tabs.map((tab) => {
                      const active = resolvedActiveTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          data-id={`settings:${tab.id}`}
                          data-scope-item="row"
                          data-settings-tab-id={tab.id}
                          {...stylex.props(
                            styles.compactNavItem,
                            active && styles.compactNavItemSelected
                          )}
                          onClick={() => selectTab(tab.id)}
                        >
                          {t(tab.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            {canReportBug ? (
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('bugReport.title', 'Report a bug')}
                onClick={handleReportBug}
              >
                <Bug aria-hidden="true" />
              </Button>
            ) : null}
          </FocusScope>
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

          {/* Tabs.Panel owns its DOM id; FocusScope consumes id as a keyboard-scope key. */}
          <Tabs.Panel
            value={resolvedActiveTab}
            keepMounted
            render={<div {...stylex.props(styles.content)} />}
          >
            <FocusScope id={contentScopeId} {...stylex.props(styles.content)}>
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
              <div
                ref={setPane}
                {...stylex.props(
                  // Declared again here so the tokens resolve against the pane's own
                  // `--card` (white in light mode); see `lody-ui-palette.stylex.ts`.
                  resolvedTheme === 'dark' ? productDarkPalette : productLightPalette,
                  settingsFlat,
                  styles.surface,
                  surface.canvas
                )}
                data-settings-surface=""
              >
                <header {...stylex.props(styles.header, styles.paneInset, styles.headerFlush)}>
                  <div {...stylex.props(styles.headerColumn)}>
                    <div {...stylex.props(styles.headerRow)}>
                      {/* The inner box keeps page-title sizing from competing with dialog styles. */}
                      <Dialog.Title {...stylex.props(styles.headerTitle)}>
                        <span {...stylex.props(surface.pageTitle)}>
                          {t(activeTabConfig.labelKey)}
                        </span>
                      </Dialog.Title>
                      <div ref={setActionsSlot} {...stylex.props(styles.headerActions)} />
                    </div>
                    <p ref={setLeadSlot} {...stylex.props(styles.headerLead)} />
                  </div>
                </header>
                <SettingsPaneHeaderProvider value={headerSlots}>
                  <div {...stylex.props(styles.paneBody)}>
                    {usesInternalScrolling ? (
                      <div {...stylex.props(styles.fill, styles.paneInset)}>
                        <div {...stylex.props(styles.fill, styles.paneColumn)}>
                          <SettingsTabContent tabId={resolvedActiveTab} />
                        </div>
                      </div>
                    ) : (
                      <ScrollArea {...stylex.props(styles.fill)}>
                        <div {...stylex.props(styles.paneInset)}>
                          <div {...stylex.props(styles.paneColumn)}>
                            <SettingsTabContent tabId={resolvedActiveTab} />
                          </div>
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                </SettingsPaneHeaderProvider>
              </div>
            </FocusScope>
          </Tabs.Panel>
        </div>
      </Tabs.Root>
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
