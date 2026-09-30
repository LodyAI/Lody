'use client';

import { createContext, useContext } from 'react';
import type { SessionId } from '@lody/shared';
import type { SessionNavigationTarget } from '@/lib/session-navigation';

const SESSION_LINK_PREFIX = 'session://';
const SESSION_LINK_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/**
 * The Session a `session://<id>` Markdown link names, or `null` for any other
 * href. Session mentions reach the agent as `[@Title](session://<id>)`, and
 * agents quote them back in that form, so this is the one shape to recognise.
 */
export function parseSessionLinkHref(href: string): SessionId | null {
  if (!href.startsWith(SESSION_LINK_PREFIX)) return null;
  const id = href.slice(SESSION_LINK_PREFIX.length).replace(/\/+$/u, '');
  return SESSION_LINK_ID_PATTERN.test(id) ? (id as SessionId) : null;
}

/**
 * Opens a Session named by a Markdown `session://` link. Absent outside a live
 * Session workspace (share pages, settings), where the link renders inert.
 */
const SessionLinkContext = createContext<((target: SessionNavigationTarget) => void) | null>(null);

export const SessionLinkProvider = SessionLinkContext.Provider;

export function useSessionLinkNavigator() {
  return useContext(SessionLinkContext);
}
