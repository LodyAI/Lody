/**
 * Relay an npm-installed daemon to the managed fixed service entry.
 *
 * The npm installation is never modified. Until the managed daemon reports
 * ready at the exact target version, npm either keeps the Host lease or takes
 * it back; the installation is published (so launchers forward to the managed
 * service) only after that readiness. See specs/daemon-upgrade-installation.md.
 */
/**
 * A relay leaves the managed runner as a detached child of the exiting npm
 * watchdog. When a service manager owns the watchdog (a systemd unit, a launchd
 * job), stopping that unit kills the managed runner too, and a clean exit does
 * not restart it. Such installations keep the explicit migration. Detection is
 * best-effort: other supervisors (pm2, supervisord, runit, containers) are not
 * recognised.
 */
export function canRelayNpmInstallation(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  /** Contents of /proc/self/cgroup on Linux; null when unavailable. */
  cgroup: string | null
): boolean {
  if (platform === 'win32') return false;
  if (platform === 'darwin') {
    // GUI terminals inherit `application.<bundle>` (or `0` from Terminal.app);
    // a launchd job carries its own label.
    const label = env.XPC_SERVICE_NAME;
    return !label || label === '0' || label.startsWith('application.');
  }
  if (platform === 'linux' && cgroup) {
    // Desktop shells live in app-*.scope / vte-spawn-*.scope; a unit ends in `.service`.
    const unified = cgroup
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3)
      .trim();
    const leaf = unified?.split('/').at(-1) ?? '';
    return !leaf.endsWith('.service');
  }
  return true;
}

/** An npm install has no managed channel record; its version's prerelease tag names it. */
export function npmInstallationChannel(version: string): 'stable' | 'next' | 'nightly' {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(version)?.[1];
  if (!prerelease) return 'stable';
  return prerelease.startsWith('nightly') ? 'nightly' : 'next';
}

/**
 * Phase an npm runner records for an operation it finds at startup, after it
 * acquired the exclusive Host lease. Unfinished preparation is abandoned, and a
 * relay `blocked` record is released: owning the lease proves the runner whose
 * termination was unconfirmed is gone, so the block no longer protects anything.
 */
export function npmStartupOperationPhase(phase: string): 'failed' | null {
  return ['preparing', 'prepared', 'waiting', 'blocked'].includes(phase) ? 'failed' : null;
}

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

export async function relayToManagedService(
  deps: RelayDeps,
  /** Aborted when the daemon is asked to stop; checked before ownership moves. */
  signal?: AbortSignal
): Promise<RelayOutcome> {
  let service: string;
  try {
    service = await deps.installFixedEntry();
    await deps.selectRelease();
    await deps.recordPhase('applied');
  } catch (error) {
    await deps.recordPhase('failed');
    return { kind: 'restored', reason: message(error) };
  }

  if (signal?.aborted) {
    await deps.recordPhase('failed');
    return { kind: 'restored', reason: 'Daemon stop requested' };
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
  // Another healthy host took the machine: the update failed, but nothing is
  // stuck, so the record must not block later updates.
  await deps.recordPhase(launched.status === 'occupied' ? 'failed' : 'blocked');
  return { kind: 'blocked', reason: `${reason}; ownership could not be reclaimed` };
}
