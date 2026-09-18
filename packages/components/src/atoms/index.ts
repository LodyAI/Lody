import { atom } from 'jotai';
import type { ElectronLoginState } from '@lody/shared/electron-ipc';
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
export * from './layout-state';
export * from './settings-machine-tab';
export * from './focus-layer';
export * from './onboarding';
export * from './bug-report';
export * from './join-community';

export const userAtom = atom<CurrentUser | null>(readBootstrappedCurrentUser());

// Fence root auth invalidation while waiting for the browser or exchanging its
// callback. The phase atom separately controls progress and retry UI.
export const electronDeepLinkSignInInProgressAtom = atom(false);
export const electronLoginPhaseAtom = atom<ElectronLoginState['phase']>('idle');
export const electronLoginErrorAtom = atom<ElectronLoginState['error']>(null);

// Native sign-in finishes in the same WebView lifecycle. Keep root session
// invalidation fenced from sign-in start through the successful navigation so a
// late get-session response for the replaced Capacitor credential cannot sign
// out the newly established session.
export const nativeSignInInProgressAtom = atom(false);
