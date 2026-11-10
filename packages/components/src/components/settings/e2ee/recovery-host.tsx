import { createContext, useContext, useState, type ComponentType } from 'react';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { RecoveryVaultSection } from './recovery-vault-section';

/** Account recovery controls a host composes into the encryption console's Recovery
 * tab. Desktop uses its main-process vault; a browser-shaped host (Web, the mobile
 * webview) provides its own section here. The section owns its account scope. */
export type E2eeRecoveryHost = {
  readonly Section: ComponentType<{ accountId?: string | null }>;
};

export const E2eeRecoveryHostContext = createContext<E2eeRecoveryHost | null>(null);

/** The Recovery tab's content for this host, or undefined when the host has none, so
 * the console shows where recovery can be set up instead of an empty tab. */
export function useE2eeRecoverySection(): E2eeRecoveryHost['Section'] | undefined {
  const host = useContext(E2eeRecoveryHostContext);
  const [desktop] = useState(() => !!getIpcServices()?.e2ee);
  return host?.Section ?? (desktop ? RecoveryVaultSection : undefined);
}
