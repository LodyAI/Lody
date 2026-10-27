import { useCallback, useRef } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface HistoryState {
    focusComposerSessionId?: string;
    /** Present a just-created mobile session in place of its new-chat composer. */
    mobileComposerSessionId?: string;
  }
}

export function getSessionCreationNavigation(
  workspaceName: string,
  sessionId: string,
  usesMobileKeyboard: boolean
) {
  return {
    to: '/$workspaceName/sessions/$sessionId' as const,
    params: { workspaceName, sessionId },
    state: {
      focusComposerSessionId: usesMobileKeyboard ? undefined : sessionId,
      mobileComposerSessionId: usesMobileKeyboard ? sessionId : undefined,
    },
  };
}

/** A navigation owns one focus handoff, consumed when its composer actually mounts. */
export function useComposerNavigationFocus(sessionId: string) {
  const router = useRouter();
  const entryKey = useRouterState({ select: (state) => state.location.state.__TSR_key });
  return useCallback(() => {
    const location = router.history.location;
    if (
      location.state.__TSR_key !== entryKey ||
      location.state.focusComposerSessionId !== sessionId
    ) {
      return false;
    }
    // Consume before focusing: remounts, Back, and reload must not replay it.
    router.history.replace(location.href, {
      ...location.state,
      focusComposerSessionId: undefined,
    });
    return true;
  }, [entryKey, router, sessionId]);
}

/** Latch this entry's presentation until it closes, including delayed portal renders. */
export function useMobileComposerPresentation(sessionId: string | undefined) {
  const router = useRouter();
  const navigation = useRouterState({ select: (state) => state.location });
  const replacesComposer =
    sessionId != null && navigation.state.mobileComposerSessionId === sessionId;
  const entryRef = useRef<{ key: string; index: number; sessionId: string } | null>(null);
  const drawerKeyRef = useRef('session-drawer');
  if (
    replacesComposer &&
    (!entryRef.current ||
      entryRef.current.sessionId !== sessionId ||
      entryRef.current.index !== navigation.state.__TSR_index)
  ) {
    entryRef.current = {
      key: navigation.state.__TSR_key!,
      index: navigation.state.__TSR_index,
      sessionId,
    };
  }
  if (
    entryRef.current &&
    (entryRef.current.index !== navigation.state.__TSR_index ||
      entryRef.current.sessionId !== sessionId)
  )
    entryRef.current = null;
  if (replacesComposer && entryRef.current) drawerKeyRef.current = entryRef.current.key;
  const skipOpenAnimation =
    sessionId != null &&
    entryRef.current?.sessionId === sessionId &&
    entryRef.current.index === navigation.state.__TSR_index;
  const onPresented = useCallback(() => {
    const location = router.history.location;
    if (!sessionId || location.state.mobileComposerSessionId !== sessionId) return;
    router.history.replace(location.href, {
      ...location.state,
      mobileComposerSessionId: undefined,
    });
  }, [router, sessionId]);
  return {
    key: drawerKeyRef.current,
    defaultOpen: skipOpenAnimation,
    skipOpenAnimation,
    onPresented,
  };
}
