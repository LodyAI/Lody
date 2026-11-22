import { createLodyAuthClient } from '@lody/components/lib/auth';
import { capacitorClient } from 'better-auth-capacitor/client';

export const authClient = createLodyAuthClient({
  disableDefaultFetchPlugins: true,
  additionalPlugins: [
    capacitorClient({
      scheme: 'lody',
      storagePrefix: 'better-auth',
    }),
  ],
});
