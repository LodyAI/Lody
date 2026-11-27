'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { openAppActionDeepLink, openSessionDeepLink } from '@/lib/session-deep-link';
import {
  parseAppActionLink,
  parseSessionLink,
  type AppActionLink,
  type SessionLink,
} from '@lody/shared/session-link';
import type { SessionId } from '@lody/shared';
import type { SessionNavigationTarget } from '@/lib/session-navigation';

/**
 * Recognize current resource links and historical session:// references.
 */
export function parseSessionLinkHref(href: string): SessionId | null {
  return (parseSessionLink(href)?.sessionId as SessionId | undefined) ?? null;
}

export function parseAppActionLinkHref(href: string): AppActionLink | null {
  if (!href.includes('://')) return null;
  return parseAppActionLink(href);
}

/**
 * Opens a Session named by a Markdown resource link. Absent outside a live
 * Session workspace (share pages, settings), where the link renders inert.
 */
const SessionLinkContext = createContext<
  ((target: SessionNavigationTarget & Pick<SessionLink, 'workspaceId'>) => void) | null
>(null);

const AppActionLinkContext = createContext<((target: AppActionLink) => void) | null>(null);

export function SessionLinkProvider({
  enabled,
  onNavigate,
  children,
}: {
  enabled: boolean;
  onNavigate?: (target: SessionNavigationTarget & Pick<SessionLink, 'workspaceId'>) => void;
  children: ReactNode;
}) {
  // Resource links always select their exact target, including in this workspace.
  // Ordinary related-session navigation may instead restore the last active tab.
  return (
    <SessionLinkContext.Provider value={enabled ? (onNavigate ?? openSessionDeepLink) : null}>
      <AppActionLinkContext.Provider value={enabled ? openAppActionDeepLink : null}>
        {children}
      </AppActionLinkContext.Provider>
    </SessionLinkContext.Provider>
  );
}

export function useSessionLinkNavigator() {
  return useContext(SessionLinkContext);
}

export function useAppActionLinkNavigator() {
  return useContext(AppActionLinkContext);
}
