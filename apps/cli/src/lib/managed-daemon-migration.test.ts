import { describe, expect, it } from 'vitest';
import {
  canRelayNpmInstallation,
  npmInstallationChannel,
  relayToManagedService,
  type RelayDeps,
} from './managed-daemon-migration';

/**
 * An npm daemon migrating to the managed service must never strand the machine:
 * until the managed daemon reports ready, the npm installation keeps ownership or
 * takes it back, and launchers keep starting npm.
 */
function harness(launch: RelayDeps['launch'], overrides: Partial<RelayDeps> = {}) {
  const events: string[] = [];
  let owned = true;
  const deps: RelayDeps = {
    installFixedEntry: async () => {
      events.push('install');
      return '/managed/service';
    },
    selectRelease: async () => void events.push('select'),
    recordPhase: async (phase) => void events.push(`phase:${phase}`),
    releaseOwnership: async () => {
      owned = false;
      events.push('release');
    },
    reclaimOwnership: async () => {
      owned = true;
      events.push('reclaim');
      return true;
    },
    launch: async (service) => {
      events.push(`launch:${service}`);
      return launch(service);
    },
    publish: async (service) => void events.push(`publish:${service}`),
    ...overrides,
  };
  return { deps, events, owned: () => owned };
}

describe('npm to managed relay migration', () => {
  it('publishes the managed installation only after the managed daemon reports ready', async () => {
    const { deps, events, owned } = harness(async () => ({ status: 'ready' }));
    expect(await relayToManagedService(deps)).toEqual({ kind: 'migrated' });
    expect(events).toEqual([
      'install',
      'select',
      'phase:applied',
      'release',
      'launch:/managed/service',
      'publish:/managed/service',
    ]);
    expect(owned()).toBe(false);
  });

  it('a managed daemon that fails readiness hands ownership back to npm and records a rollback', async () => {
    const { deps, events, owned } = harness(async () => ({
      status: 'error',
      message: 'Daemon reported version 1.0.0; expected 1.2.3',
    }));
    expect(await relayToManagedService(deps)).toEqual({
      kind: 'restored',
      reason: 'Daemon reported version 1.0.0; expected 1.2.3',
    });
    expect(events).not.toContain('publish:/managed/service');
    expect(events.slice(-2)).toEqual(['reclaim', 'phase:rolled-back']);
    expect(owned()).toBe(true);
  });

  it('a launch that throws is treated as not ready', async () => {
    const { deps, events } = harness(async () => {
      throw new Error('spawn EACCES');
    });
    expect(await relayToManagedService(deps)).toEqual({ kind: 'restored', reason: 'spawn EACCES' });
    expect(events).toContain('phase:rolled-back');
  });

  it('when ownership cannot be taken back the relay reports blocked instead of starting npm', async () => {
    const { deps, events } = harness(async () => ({ status: 'timeout' }), {
      reclaimOwnership: async () => false,
    });
    expect(await relayToManagedService(deps)).toEqual({
      kind: 'blocked',
      reason: 'Managed daemon did not become ready (timeout); ownership could not be reclaimed',
    });
    expect(events.at(-1)).toBe('phase:blocked');
  });

  it('a failed fixed-entry install never releases npm ownership', async () => {
    const { deps, events, owned } = harness(async () => ({ status: 'ready' }), {
      installFixedEntry: async () => {
        throw new Error('disk full');
      },
    });
    expect(await relayToManagedService(deps)).toEqual({ kind: 'restored', reason: 'disk full' });
    expect(events).toEqual(['phase:failed']);
    expect(owned()).toBe(true);
  });
});

describe('npm relay eligibility', () => {
  const desktopShell =
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope\n';
  it('relays only POSIX npm watchdogs that no service manager owns', () => {
    expect(canRelayNpmInstallation({}, 'linux', desktopShell)).toBe(true);
    expect(canRelayNpmInstallation({}, 'darwin', null)).toBe(true);
    expect(canRelayNpmInstallation({}, 'win32', null)).toBe(false);
    // A systemd unit's stop would kill the detached managed runner with its cgroup.
    expect(
      canRelayNpmInstallation({ INVOCATION_ID: 'abc' }, 'linux', '0::/system.slice/lody.service\n')
    ).toBe(false);
    // launchd jobs carry their label; GUI terminals carry `application.*` or `0`.
    expect(canRelayNpmInstallation({ XPC_SERVICE_NAME: 'com.example.lody' }, 'darwin', null)).toBe(
      false
    );
  });
  it('does not mistake an ordinary desktop terminal for a service', () => {
    expect(canRelayNpmInstallation({ XPC_SERVICE_NAME: '0' }, 'darwin', null)).toBe(true);
    expect(
      canRelayNpmInstallation(
        { XPC_SERVICE_NAME: 'application.com.googlecode.iterm2.1234' },
        'darwin',
        null
      )
    ).toBe(true);
    // Terminal shells may inherit INVOCATION_ID from their user service.
    expect(canRelayNpmInstallation({ INVOCATION_ID: 'abc' }, 'linux', desktopShell)).toBe(true);
  });
});

describe('npm installation channel', () => {
  it('derives the channel from the running npm version so batch never crosses channels', () => {
    expect(npmInstallationChannel('1.2.3')).toBe('stable');
    expect(npmInstallationChannel('1.3.0-next.4')).toBe('next');
    expect(npmInstallationChannel('1.3.0-nightly.20261111')).toBe('nightly');
  });
});

describe('relay cancellation and occupancy', () => {
  it('a stop requested before the switch keeps npm ownership and records failure', async () => {
    const { deps, events, owned } = harness(async () => ({ status: 'ready' }));
    const stop = new AbortController();
    stop.abort();
    expect(await relayToManagedService(deps, stop.signal)).toEqual({
      kind: 'restored',
      reason: 'Daemon stop requested',
    });
    expect(events).not.toContain('release');
    expect(events.at(-1)).toBe('phase:failed');
    expect(owned()).toBe(true);
  });
  it('another healthy host taking the machine is a failed update, not a blocked recovery', async () => {
    const { deps, events } = harness(async () => ({ status: 'occupied' }), {
      reclaimOwnership: async () => false,
    });
    expect((await relayToManagedService(deps)).kind).toBe('blocked');
    expect(events.at(-1)).toBe('phase:failed');
  });
});
