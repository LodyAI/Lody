import { parseMemberOffer, memberJoinPath } from './e2ee-member-offer';
import { isIOSRuntimeEnvironment, isNativeAppShell } from '@/lib/native-platform';

const ANDROID_BROWSER_PATTERN = /Android/i;

export function buildDesktopInviteOpenDeepLink(invitationId: string): string {
  const search = new URLSearchParams({ invitationId });
  return `lody://invite/open?${search.toString()}`;
}

export function resolveDesktopInviteDeepLinkPath(deepLinkUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(deepLinkUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'lody:' || parsed.hostname !== 'invite') {
    return null;
  }

  const action = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (action === 'open') {
    const encodedOffer = parsed.searchParams.get('memberOffer');
    if (encodedOffer !== null) {
      const offer = parseMemberOffer(encodedOffer);
      return offer ? memberJoinPath(offer) : null;
    }
    const invitationId = parsed.searchParams.get('invitationId')?.trim();
    if (!invitationId) {
      return null;
    }
    return `/invite/${encodeURIComponent(invitationId)}`;
  }

  return null;
}

export function shouldAttemptDesktopInviteHandoff(environment: {
  isElectron: boolean;
  isNativeAppShell: boolean;
  isIOSRuntime: boolean;
  userAgent: string;
}): boolean {
  return (
    !environment.isElectron &&
    !environment.isNativeAppShell &&
    !environment.isIOSRuntime &&
    !ANDROID_BROWSER_PATTERN.test(environment.userAgent)
  );
}

export function attemptDesktopInviteHandoff(deepLinkUrl: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (
    !shouldAttemptDesktopInviteHandoff({
      isElectron: window.__LODY_ELECTRON__ === true,
      isNativeAppShell: isNativeAppShell(),
      isIOSRuntime: isIOSRuntimeEnvironment(),
      userAgent: window.navigator.userAgent,
    })
  ) {
    return false;
  }

  try {
    window.location.assign(deepLinkUrl);
    return true;
  } catch {
    return false;
  }
}
