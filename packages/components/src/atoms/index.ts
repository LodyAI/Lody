import { atom } from 'jotai';
import type { CurrentUser } from '@/lib/current-user';
import { readBootstrappedCurrentUser } from '@/lib/auth-bootstrap';

export * from './settings';
export * from './machines';
export * from './agents';
export * from './ui';
export * from './workspace-context';
export * from './repo';
export * from './runtime';
export * from './doc-meta';
export * from './machine-flock';
export * from './control-connection';
export * from './local-storage-cache';
export * from './sidebar-state';
export * from './settings-machine-tab';
export * from './focus-layer';
export * from './onboarding';
export * from './bug-report';
export * from './join-community';

export const userAtom = atom<CurrentUser | null>(readBootstrappedCurrentUser());

// True while an Electron desktop sign-in is returning from the system browser
// through the `lody://auth/callback#token=…` deep link and the session has not
// finished resolving yet. The login page shows a spinner while this is set, and
// the root auth-invalidation effect skips its "session expired" sign-out/toast
// so the transient unauthenticated window mid-login is not mistaken for an
// expired session and used to abort the in-flight login.
export const electronDeepLinkSignInInProgressAtom = atom(false);

// Native sign-in finishes in the same WebView lifecycle. Keep root session
// invalidation fenced from sign-in start through the successful navigation so a
// late get-session response for the replaced Capacitor credential cannot sign
// out the newly established session.
export const nativeSignInInProgressAtom = atom(false);
