/**
 * Relay an npm-installed daemon to the managed fixed service entry.
 *
 * The npm installation is never modified. Until the managed daemon reports
 * ready at the exact target version, npm either keeps the Host lease or takes
 * it back; the installation is published (so launchers forward to the managed
 * service) only after that readiness. See specs/daemon-upgrade-installation.md.
 */
export type RelayLaunchResult = { status: 'ready' } | { status: string; message?: string };

export type RelayDeps = {
  /** Copy the verified capsule to the fixed entry without publishing it. */
  installFixedEntry: () => Promise<string>;
  /** Pin the managed service to the verified target release. */
  selectRelease: () => Promise<void>;
  /**
   * Persist the operation outcome. `applied` is written before launch because the
   * managed runner treats an interrupted `switching`/`observing` record as blocked;
   * a failed launch overwrites it before npm comes back online.
   */
  recordPhase: (phase: 'applied' | 'rolled-back' | 'blocked' | 'failed') => Promise<void>;
  releaseOwnership: () => Promise<void>;
  reclaimOwnership: () => Promise<boolean>;
  /** Start the managed runner and await its bounded readiness handshake. */
  launch: (service: string) => Promise<RelayLaunchResult>;
  publish: (service: string) => Promise<void>;
};

export type RelayOutcome =
  | { kind: 'migrated' }
  | { kind: 'restored'; reason: string }
  | { kind: 'blocked'; reason: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function relayToManagedService(deps: RelayDeps): Promise<RelayOutcome> {
  let service: string;
  try {
    service = await deps.installFixedEntry();
    await deps.selectRelease();
    await deps.recordPhase('applied');
  } catch (error) {
    await deps.recordPhase('failed');
    return { kind: 'restored', reason: message(error) };
  }

  await deps.releaseOwnership();
  let launched: RelayLaunchResult;
  try {
    launched = await deps.launch(service);
  } catch (error) {
    launched = { status: 'error', message: message(error) };
  }
  if (launched.status === 'ready') {
    // The managed daemon already owns the machine. A failed publication only
    // stops launchers from forwarding; it must not stop the running daemon.
    await deps.publish(service).catch(() => {});
    return { kind: 'migrated' };
  }

  const reason =
    'message' in launched && launched.message
      ? launched.message
      : `Managed daemon did not become ready (${launched.status})`;
  if (await deps.reclaimOwnership()) {
    await deps.recordPhase('rolled-back');
    return { kind: 'restored', reason };
  }
  await deps.recordPhase('blocked');
  return { kind: 'blocked', reason: `${reason}; ownership could not be reclaimed` };
}
