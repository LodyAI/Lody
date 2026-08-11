import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import type { MachineId } from '@lody/shared';
import {
  currentWorkspaceSlugAtom,
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import {
  SETTINGS_DEFAULT_TAB,
  type SettingsTabId,
} from '@/components/settings/settings-tabs';
import { useAppCapability } from '@/lib/app-platform';
import { useIsMobile } from './use-mobile';

type OpenSettingsOptions = {
  machineId?: MachineId;
  projectKey?: string;
};

/**
 * Single entry point for opening settings from anywhere in the app.
 *
 * Desktop (non-mobile): settings is a modal overlay — open it by flipping the
 * `settingsDialogOpenAtom` and selecting a tab, without navigating away from the
 * current page (so the chat/workspace stays mounted behind the dialog).
 *
 * Mobile: settings stays a full-page route, so we navigate to the matching route,
 * exactly as before.
 */
export function useOpenSettings() {
  const isMobile = useIsMobile();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveTab = useSetAtom(settingsActiveTabAtom);
  const setSelectedMachineId = useSetAtom(settingsSelectedMachineIdAtom);
  const setSelectedProjectKey = useSetAtom(settingsSelectedProjectKeyAtom);
  const cloudAccountAvailable = useAppCapability('cloudAccount');

  const openSettings = useCallback(
    (tab?: SettingsTabId, options?: OpenSettingsOptions) => {
      if (!workspaceSlug) return;

      const resolvedTab = tab ?? (cloudAccountAvailable ? SETTINGS_DEFAULT_TAB : 'preferences');
      if (options) {
        setSelectedMachineId(options.machineId ?? null);
        setSelectedProjectKey(options.projectKey ?? null);
      }

      if (!isMobile) {
        setActiveTab(resolvedTab);
        setOpen(true);
        return;
      }

      // Mobile: navigate to the matching full-page route. Each `to` is a literal so
      // the router can type-check params (mirrors the former route-based tab nav).
      const params = { workspaceName: workspaceSlug };
      switch (resolvedTab) {
        case 'account':
          void router.navigate({ to: '/$workspaceName/settings/account', params });
          return;
        case 'preferences':
          void router.navigate({ to: '/$workspaceName/settings/preferences', params });
          return;
        case 'appearance':
          void router.navigate({ to: '/$workspaceName/settings/appearance', params });
          return;
        case 'workspace':
          void router.navigate({ to: '/$workspaceName/settings/workspace', params });
          return;
        case 'people':
          void router.navigate({ to: '/$workspaceName/settings/people', params });
          return;
        case 'ai-usage':
          void router.navigate({ to: '/$workspaceName/settings/ai-usage', params });
          return;
        case 'projects':
          void router.navigate({
            to: '/$workspaceName/settings/projects',
            params,
            search: {
              machine: options?.machineId,
              project: options?.projectKey,
            },
          });
          return;
        case 'machines':
          void router.navigate({
            to: '/$workspaceName/settings/machines',
            params,
            search: { machine: options?.machineId },
          });
          return;
        case 'agents':
          void router.navigate({
            to: '/$workspaceName/settings/agents',
            params,
            search: { machine: options?.machineId },
          });
          return;
        case 'github':
          void router.navigate({ to: '/$workspaceName/settings/github', params });
          return;
        case 'keyboard-shortcuts':
          void router.navigate({ to: '/$workspaceName/settings/keyboard-shortcuts', params });
          return;
        case 'about':
          void router.navigate({ to: '/$workspaceName/settings/about', params });
          return;
        case 'billing':
          void router.navigate({ to: '/$workspaceName/settings/billing', params });
          return;
        default:
          void router.navigate({ to: '/$workspaceName/settings', params });
      }
    },
    [
      cloudAccountAvailable,
      isMobile,
      router,
      setActiveTab,
      setOpen,
      setSelectedMachineId,
      setSelectedProjectKey,
      workspaceSlug,
    ]
  );

  const closeSettings = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  return { openSettings, closeSettings };
}
