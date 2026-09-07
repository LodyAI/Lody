import { useCallback } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface HistoryState {
    focusComposerSessionId?: string;
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
    state: { focusComposerSessionId: usesMobileKeyboard ? undefined : sessionId },
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
