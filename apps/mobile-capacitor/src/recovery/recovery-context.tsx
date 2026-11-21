import { createContext } from 'react';
import type { Effect } from 'effect';
import type { PersonalCloudConnection } from '@lody/client-e2ee';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eePasskeyPort } from '@lody/platform/e2ee-passkey';

export type MobileRecoveryConfig = {
  readonly enabled: () => boolean;
  readonly client: PersonalCloudConnection['client'];
  readonly passkey?: E2eePasskeyPort;
  readonly run: <A>(program: Effect.Effect<A, unknown>) => Promise<A>;
  readonly defaultLabel: () => Promise<string>;
  /** The application's encrypted runtime, whose identity owner runs setup and restore. */
  readonly runtime: () => E2eeWorkspaceRuntime | undefined;
};
export const MobileRecoveryContext = createContext<MobileRecoveryConfig | null>(null);
