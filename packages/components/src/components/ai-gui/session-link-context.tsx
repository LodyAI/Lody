'use client';

import { createContext, useContext } from 'react';
import { parseSessionLink, type SessionLink } from '@lody/shared/session-link';
import type { SessionId } from '@lody/shared';
import type { SessionNavigationTarget } from '@/lib/session-navigation';

/**
 * Recognize current resource links and historical session:// references.
 */
export function parseSessionLinkHref(href: string): SessionId | null {
  return (parseSessionLink(href)?.sessionId as SessionId | undefined) ?? null;
}

/**
 * Opens a Session named by a Markdown resource link. Absent outside a live
 * Session workspace (share pages, settings), where the link renders inert.
 */
const SessionLinkContext = createContext<
  ((target: SessionNavigationTarget & Pick<SessionLink, 'workspaceId'>) => void) | null
>(null);

export const SessionLinkProvider = SessionLinkContext.Provider;

export function useSessionLinkNavigator() {
  return useContext(SessionLinkContext);
}
