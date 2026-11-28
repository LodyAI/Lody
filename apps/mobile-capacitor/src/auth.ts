import { createLodyAuthClient } from '@lody/components/lib/auth';
import { acquireAuthSessionStore } from '@lody/components/lib/auth-session-store';
import { capacitorClient, isNativePlatform } from 'better-auth-capacitor/client';
import { createCapacitorAuthHygienePlugin } from './capacitor-auth-hygiene';

const isNative = isNativePlatform();

export const authClient = createLodyAuthClient({
  disableDefaultFetchPlugins: true,
  // Native shells use Capacitor Preferences + Bearer auth via capacitorClient().
  // Mounting crossDomainClient() alongside it maintains two competing session
  // jars and can trigger a self-aborting /get-session loop on expired sessions.
  disableCrossDomain: isNative,
  additionalPlugins: [
    createCapacitorAuthHygienePlugin({
      storagePrefix: 'better-auth',
    }),
    capacitorClient({
      scheme: 'lody',
      storagePrefix: 'better-auth',
    }),
  ],
});

const session = acquireAuthSessionStore(authClient);
session.start();

export function getAuthUserId(): string | null {
  const id = session.getSnapshot().data?.user.id;
  return typeof id === 'string' && id ? id : null;
}

export function subscribeAuthUserId(listener: (userId: string | null) => void): () => void {
  return session.subscribe(() => listener(getAuthUserId()));
}
