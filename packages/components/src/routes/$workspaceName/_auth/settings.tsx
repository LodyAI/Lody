import { useCallback, useEffect, useMemo } from 'react';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useSetAtom } from 'jotai';
import {
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import type { MachineId } from '@lody/shared';
import { AppThemeShell } from '@/components/app-theme-shell';
import { isNativeAppShell } from '@/lib/native-platform';
import { getSettingsBackDestination, resolveSettingsCloseTo } from '@/lib/settings-navigation';
import { useIsMobile } from '@/hooks/use-mobile';
import { SettingsDataCacheProvider } from '@/components/settings/settings-data-cache';
import {
  getActiveSettingsTabId,
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TAB_CONFIGS,
} from '@/components/settings/settings-tabs';
import { MobileSettingsLayout } from '@/components/mobile/mobile-settings-layout';
import type { MobileWorkspaceTab } from '@/components/mobile/mobile-workspace-tabbar';

type SettingsSearch = {
  from?: string;
};

export const Route = createFileRoute('/$workspaceName/_auth/settings')({
  component: SettingsLayoutComponent,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
});

function isSettingsListPath(pathname: string, workspaceName: string): boolean {
  return pathname === `/${workspaceName}/settings` || pathname === `/${workspaceName}/settings/`;
}

function SettingsLayoutComponent() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isNativeApp = isNativeAppShell();
  const { workspaceName } = Route.useParams();

  const settingsListPage = isSettingsListPath(location.pathname, workspaceName);
  const activeTabId = getActiveSettingsTabId(location.pathname);
  const activeTab = useMemo(
    () => SETTINGS_TAB_CONFIGS.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId]
  );

  // Mobile machine detail views (URL has ?machine=<id>) swap the settings
  // header for a back-only bar that returns to the machine list.
  const locationSearch = location.search as Record<string, unknown>;
  const hasAgentConfigMachineParam =
    typeof locationSearch.machine === 'string' && locationSearch.machine.length > 0;
  const isMobileMachineDetail =
    isMobile &&
    (activeTabId === 'agents' || activeTabId === 'machines') &&
    hasAgentConfigMachineParam;

  const handleBack = useCallback(() => {
    if (isMobileMachineDetail) {
      void navigate({
        to:
          activeTabId === 'agents'
            ? '/$workspaceName/settings/agents'
            : '/$workspaceName/settings/machines',
        params: { workspaceName },
        search: (prev) => ({ ...prev, machine: undefined }),
        replace: true,
      });
      return;
    }

    const destination = getSettingsBackDestination({
      isMobile,
      settingsListPage,
    });

    if (destination === 'settings-list') {
      void navigate({
        to: '/$workspaceName/settings',
        params: { workspaceName },
        search: (prev) => prev,
        replace: true,
      });
      return;
    }

    // Settings exits back to the new session landing instead of browser history.
    void navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName },
    });
  }, [activeTabId, isMobile, isMobileMachineDetail, navigate, settingsListPage, workspaceName]);

  // Close (exit) settings entirely — back to where it was opened from (the `from` search
  // param, preserved across tabs) or the chat landing. Used by ⌘, (toggle) and Esc.
  const settingsFrom = (location.search as { from?: string }).from;
  const handleCloseSettings = useCallback(() => {
    const closeTo = resolveSettingsCloseTo(settingsFrom);
    if (closeTo) {
      void navigate({ to: closeTo });
      return;
    }
    void navigate({ to: '/$workspaceName/chat', params: { workspaceName } });
  }, [navigate, settingsFrom, workspaceName]);

  // Desktop: settings is a modal overlay, not a page. If we land on a settings route
  // anyway (deep link, Electron "About" menu, an old bookmark), open the modal at the
  // URL's tab and redirect the URL back to where settings was opened from (or chat) so
  // the workspace stays visible behind the dialog instead of a blank settings page.
  const setSettingsModalOpen = useSetAtom(settingsDialogOpenAtom);
  const setSettingsModalTab = useSetAtom(settingsActiveTabAtom);
  const setSettingsMachineTarget = useSetAtom(settingsSelectedMachineIdAtom);
  const setSettingsProjectTarget = useSetAtom(settingsSelectedProjectKeyAtom);
  useEffect(() => {
    if (isMobile) return;
    setSettingsModalTab(activeTabId ?? SETTINGS_DEFAULT_TAB);
    setSettingsMachineTarget(
      typeof locationSearch.machine === 'string' ? (locationSearch.machine as MachineId) : null
    );
    setSettingsProjectTarget(
      typeof locationSearch.project === 'string' ? locationSearch.project : null
    );
    setSettingsModalOpen(true);
    const closeTo = resolveSettingsCloseTo(settingsFrom);
    if (closeTo) {
      void navigate({ to: closeTo, replace: true });
    } else {
      void navigate({ to: '/$workspaceName/chat', params: { workspaceName }, replace: true });
    }
  }, [
    isMobile,
    activeTabId,
    settingsFrom,
    navigate,
    workspaceName,
    setSettingsModalOpen,
    setSettingsModalTab,
    setSettingsMachineTarget,
    setSettingsProjectTarget,
    locationSearch.machine,
    locationSearch.project,
  ]);

  // Esc closes the settings page — unless a modal/menu/popover (incl. shortcut recording,
  // which stops the event in the capture phase) owns Esc, or an input handler already
  // consumed it (defaultPrevented). Mobile-only: desktop uses the modal's own Esc and
  // redirects away from this route anyway.
  useEffect(() => {
    if (!isMobile) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (typeof document === 'undefined') return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
        )
      ) {
        return;
      }
      handleCloseSettings();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseSettings, isMobile]);

  const mobileTitle = settingsListPage
    ? t('settings.title')
    : activeTab
      ? t(activeTab.labelKey)
      : t('settings.title');

  /* Workspace tabbar (本地 / GitHub / Chat / 设置) navigates back to the
     chat landing for the first three tabs; the 设置 tab is a no-op
     since we're already on settings (could collapse to the settings
     list, but staying-put feels closer to iOS behavior). Only rendered
     at the top-level settings list — sub-settings views like
     `/settings/general` have their own deep navigation and a tabbar at
     the bottom would compete with that. */
  const showWorkspaceTabBar = settingsListPage && !isMobileMachineDetail;
  const handleWorkspaceTabSelect = useCallback(
    (tab: MobileWorkspaceTab) => {
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName },
        search: { context: tab },
      });
    },
    [navigate, workspaceName]
  );

  // Desktop renders nothing here — the effect above opens the modal and redirects away.
  if (!isMobile) {
    return null;
  }

  return (
    <AppThemeShell>
      <SettingsDataCacheProvider>
        <MobileSettingsLayout
          title={mobileTitle}
          isNativeApp={isNativeApp}
          isMachineDetail={isMobileMachineDetail}
          isAgentConfigTab={activeTab?.id === 'agents'}
          onBack={handleBack}
          onWorkspaceTabSelect={showWorkspaceTabBar ? handleWorkspaceTabSelect : undefined}
          workspaceTabLabels={{
            localTab: t('chat.contextSwitch.localProjects', 'Local'),
            githubTab: t('chat.contextSwitch.github', 'GitHub'),
            chatTab: t('chat.contextSwitch.chat', 'Chat'),
          }}
        >
          <Outlet />
        </MobileSettingsLayout>
      </SettingsDataCacheProvider>
    </AppThemeShell>
  );
}
