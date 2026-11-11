import { useContext, type ComponentType } from 'react';
import { RecoveryVaultSection } from './recovery-vault-section';
import { E2eeRecoveryHostContext, useRecoveryPort } from './recovery-port';

export { E2eeRecoveryHostContext, type E2eeRecoveryHost } from './recovery-port';

/** The Recovery tab's content for this host: the shared section over the host's
 * recovery port (desktop's is its main-process vault), a host-owned section, or
 * undefined when the host has neither, so the console shows where recovery can be
 * set up instead of an empty tab. */
export function useE2eeRecoverySection(): ComponentType<{ accountId?: string | null }> | undefined {
  const host = useContext(E2eeRecoveryHostContext);
  const port = useRecoveryPort();
  if (host && 'Section' in host) return host.Section;
  return port ? RecoveryVaultSection : undefined;
}
