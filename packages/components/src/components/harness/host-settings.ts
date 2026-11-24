/*
 * Reads Sorbet's machine-wide Host settings out of the harness store and
 * writes patches back through `sorbet.updateHostSettings`. Unlike the
 * sessionDefaults-backed controls, Host settings are per machine — there is
 * no profile/device split to reconcile, so the value is whatever the machine
 * last answered and a write is a single RPC.
 */
import { useCallback } from 'react';
import type { SorbetHostSettings, SorbetHostSettingsUpdate } from '@lody/shared/local-machine-rpc';

import { sorbet } from './sorbet';
import { useHarness } from './store';

export interface HostSettings {
  /** The machine's last answer; `null` until it reports (or read failed). */
  settings: SorbetHostSettings | null;
  /** Whether the machine speaks `sorbet/host-settings-*`; gates the controls. */
  supported: boolean;
  /** Merge a patch on the machine and re-read. */
  update: (patch: SorbetHostSettingsUpdate) => Promise<void>;
}

export function useHostSettings(): HostSettings {
  const state = useHarness();
  const update = useCallback(async (patch: SorbetHostSettingsUpdate) => {
    await sorbet.updateHostSettings(patch);
  }, []);
  return {
    settings: state.hostSettings,
    supported: state.hostSettingsSupported,
    update,
  };
}
