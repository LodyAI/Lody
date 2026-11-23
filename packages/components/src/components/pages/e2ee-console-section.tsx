import type { ReactNode } from 'react';

/** The encryption console's tabs, in navigation order. */
export const E2EE_CONSOLE_TABS = [
  'overview',
  'members',
  'devices',
  'security',
  'recovery',
] as const;
export type E2eeConsoleTab = (typeof E2EE_CONSOLE_TABS)[number];

/** Places host-owned content (team invitations, pairing, recovery) on one console tab.
 * It renders its children unchanged; the console reads `tab` to decide where. */
export function E2eeConsoleSection(props: { tab: E2eeConsoleTab; children: ReactNode }) {
  return <>{props.children}</>;
}
