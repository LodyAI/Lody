import { appendUnmountedSessionDraft } from '../lib/session-composer-drafts';
import type { SessionId } from '@lody/shared';
import { pluginLandingDraftAtom } from './workspace-drafts';
import type { LodyClient } from '@lody/plugin-sdk/client';
import { useRouter } from '@tanstack/react-router';
import { useStore } from 'jotai';
import type { SessionRef } from '@lody/plugin-sdk';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../atoms/workspace-context';
import { useVisibleSessionMetas } from '../hooks/use-visible-session-metas';
import { useLayoutEffect, useRef } from 'react';
import type { DraftItem } from '@lody/plugin-sdk/client';

const composers = new Map<string, (item: DraftItem) => void>();
export function registerPluginDraftComposer(
  workspaceId: string,
  sessionId: string,
  append: (item: DraftItem) => void
) {
  const key = JSON.stringify([workspaceId, sessionId]);
  composers.set(key, append);
  return () => {
    if (composers.get(key) === append) composers.delete(key);
  };
}
export function useWorkspaceNavigation(
  workspaceId: string,
  machineId: string,
  signal: AbortSignal
) {
  const router = useRouter(),
    store = useStore();
  const { allActiveSessions: sessions } = useVisibleSessionMetas();
  const visible = useRef(sessions);
  useLayoutEffect(() => {
    visible.current = sessions;
    return () => {
      visible.current = [];
    };
  }, [sessions]);
  function check(ref: SessionRef) {
    signal.throwIfAborted();
    if (
      workspaceId !== ref.workspaceId ||
      machineId !== ref.machineId ||
      store.get(currentWorkspaceIdAtom) !== workspaceId ||
      !visible.current.some((s) => s.id === ref.sessionId && s.machineId === machineId)
    )
      throw Error('Session target unavailable');
  }
  return {
    openSession(ref: SessionRef) {
      check(ref);
      const slug = store.get(currentWorkspaceSlugAtom);
      if (!slug) throw Error('Workspace route unavailable');
      const parent = visible.current.find((s) => s.id === ref.sessionId)?.parentSessionId;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: slug, sessionId: parent ?? ref.sessionId },
        search: parent ? { tab: ref.sessionId } : {},
      });
    },
    openDraft(...[target, draft]: Parameters<LodyClient['drafts']['open']>) {
      signal.throwIfAborted();
      const slug = store.get(currentWorkspaceSlugAtom);
      if (
        !slug ||
        workspaceId !== target.workspaceId ||
        target.machineId !== machineId ||
        store.get(currentWorkspaceIdAtom) !== workspaceId
      )
        throw Error('Draft target unavailable');
      store.set(pluginLandingDraftAtom, structuredClone({ target, draft }));
      void router.navigate({ to: '/$workspaceName/chat', params: { workspaceName: slug } });
    },
    appendDraft(ref: SessionRef, item: DraftItem) {
      check(ref);
      const append = composers.get(JSON.stringify([workspaceId, ref.sessionId]));
      if (append) append(item);
      else appendUnmountedSessionDraft(workspaceId, ref.sessionId as SessionId, item);
    },
  };
}
