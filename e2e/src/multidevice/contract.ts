import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { SyncSessionUi } from './session-ui.js';

export type Membership = 'same-account' | 'different-members';
export type Backend = 'legacy' | 'native';
export type Replica = {
  mainPid: number;
  accountId: string;
  workspaceId: string;
  machineId: string;
  daemonPid: number;
  repoOwnerPid: number;
  repoInstanceId: string;
  hostEndpoint: string;
  userDataDir: string;
  dataDir: string;
  repoDir: string;
  backend: Backend;
  // Native observations come from the loaded host, not the requested build config.
  sdkVersions?: { engine: string; client: string; jsonPatch: string };
};

export type DesktopActor = {
  // Private drivers may keep Playwright in an owned child process. The UI port
  // must execute these same product interactions, without injecting Repo state.
  ui: Pick<
    SyncSessionUi,
    'send' | 'open' | 'expectStreaming' | 'expectHistory' | 'expectMissing' | 'sessionId'
  >;
  observe(): Promise<Replica>;
  setOnline(online: boolean): Promise<void>;
  restart(): Promise<DesktopActor>;
  assertStopped(): Promise<void>;
  screenshot(name: string): Promise<void>;
};

export type DesktopRound = {
  actors: [DesktopActor, DesktopActor];
  // Captures main/renderer logs, CLI backlog, process trees, network gate evidence,
  // service versions, screenshots and traces, also after partial startup failures.
  close(): Promise<void>;
};

export type CloudFixture = {
  createRound(options: {
    membership: Membership;
    backend: Backend;
    root: string;
    artifacts: string;
    agentCommands: [string, string];
  }): Promise<DesktopRound>;
};

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function assertIndependentActors(
  actors: [DesktopActor, DesktopActor],
  root: string,
  membership: Membership,
  backend: Backend
): Promise<[Replica, Replica]> {
  const replicas = await Promise.all(actors.map((actor) => actor.observe()));
  for (let i = 0; i < replicas.length; i++) {
    const replica = replicas[i]!;
    for (const field of [
      'accountId',
      'workspaceId',
      'machineId',
      'repoInstanceId',
      'hostEndpoint',
    ] as const) {
      assert.ok(replica[field], `Missing runtime observation: ${field}`);
    }
    for (const field of ['mainPid', 'daemonPid', 'repoOwnerPid'] as const) {
      assert.ok(Number.isSafeInteger(replica[field]) && replica[field] > 0, `Missing ${field}`);
    }
    assert.equal(replica.backend, backend);
    if (backend === 'native')
      assert.deepEqual(replica.sdkVersions, {
        engine: '0.1.0',
        client: '0.1.0',
        jsonPatch: '0.1.0',
      });
    for (const field of ['userDataDir', 'dataDir', 'repoDir'] as const) {
      assert.ok(
        contains(realpathSync(root), realpathSync(replica[field])),
        `${field} escaped the disposable round`
      );
    }
    assert.ok(
      contains(realpathSync(replica.dataDir), realpathSync(replica.repoDir)),
      'Repo escaped its device data directory'
    );
  }
  const [a, b] = replicas as [Replica, Replica];
  assert.equal(a.workspaceId, b.workspaceId, 'Both actors must join the same workspace');
  assert.equal(
    a.accountId === b.accountId,
    membership === 'same-account',
    'Wrong account relationship'
  );
  for (const field of ['machineId', 'daemonPid', 'repoInstanceId', 'hostEndpoint'] as const) {
    assert.notEqual(a[field], b[field], `Shared ${field} invalidates multi-device evidence`);
  }
  for (const left of [a.mainPid, a.daemonPid, a.repoOwnerPid]) {
    for (const right of [b.mainPid, b.daemonPid, b.repoOwnerPid]) {
      assert.notEqual(left, right, 'Shared process owner across devices');
    }
  }
  // Reject directory aliases, symlinks and parent/child layouts across devices.
  for (const left of [a.userDataDir, a.dataDir]) {
    for (const right of [b.userDataDir, b.dataDir]) {
      assert.ok(
        !contains(realpathSync(left), realpathSync(right)) &&
          !contains(realpathSync(right), realpathSync(left)),
        'Device directories overlap'
      );
    }
  }
  return [a, b];
}
