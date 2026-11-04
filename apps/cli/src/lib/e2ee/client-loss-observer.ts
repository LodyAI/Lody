import { randomUUID } from 'node:crypto';

declare const __LODY_E2E_DAEMON_LOSS__: boolean;
export const daemonLossProbeEnabled =
  typeof __LODY_E2E_DAEMON_LOSS__ !== 'undefined' &&
  __LODY_E2E_DAEMON_LOSS__ === true &&
  process.env.LODY_E2E === '1';

export type DaemonLossCode = 'e2ee_member_removed' | 'e2ee_device_revoked';
export type DaemonLossPending = {
  processorActive: number;
  processorQueued: number;
  watcherChecks: number;
  executionTurns: number;
  executionBookkeeping: number;
};
export type DaemonLossWork = { intakeClosed: boolean; pending: DaemonLossPending };
export type DaemonLossAuthority = {
  membershipId: string | null;
  ownerMembershipId: string | null;
  devicePresent: boolean;
  memberPresent: boolean;
  length: number;
  generation: number;
};
export function readDaemonLossAuthority(
  snapshot: { view: import('@lody/e2ee-core/protocol').LedgerView; generation: number } | undefined,
  ownerDevice: string,
  requesterDevice: string,
  membershipId?: string
): DaemonLossAuthority | null {
  if (!snapshot) return null;
  const state = snapshot.view.inspectState();
  const requester = state.devices.get(requesterDevice);
  const owner = state.devices.get(ownerDevice);
  const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
  const member = membershipId ?? (requester ? hex(requester.membershipId.toBytes()) : null);
  return {
    membershipId: member,
    ownerMembershipId: owner ? hex(owner.membershipId.toBytes()) : null,
    devicePresent: requester !== undefined,
    memberPresent: member !== null && state.members.has(member),
    length: snapshot.view.length,
    generation: snapshot.generation,
  };
}

type Requester = {
  requesterInstance: string;
  membershipId: string;
  ownerMembershipId: string | null;
  baselineLength: number;
  baselineGeneration: number;
  lossSequence: number;
};
type Scope = { machineId: string; accountId: string; workspaceId: string };
type ReadAuthority = (requesterDevice: string, membershipId?: string) => DaemonLossAuthority | null;

/** Read-only observations cannot stop, authorize, refresh or drain product work. */
export function createDaemonLossRegistry(enabled: boolean, pid = process.pid) {
  const processInstance = enabled ? randomUUID() : '';
  let sequence = 0;
  const listeners = new Set<() => void>();
  const rawWork = new Map<string, ReturnType<typeof createDaemonLossTasks>>();
  const rows = new Map<
    string,
    Scope & {
      ownerInstance: string;
      lossSequence: number;
      code: DaemonLossCode | null;
      retired: boolean;
      failed: boolean;
      read: () => DaemonLossWork | null;
      readAuthority?: ReadAuthority;
      requesters: Map<string, Requester>;
    }
  >();
  const changed = () => {
    if (!enabled) return;
    sequence++;
    for (const listener of [...listeners]) listener();
  };
  const inspect = (workspaceId: string, requesterDevice?: string) => {
    const row = rows.get(workspaceId);
    if (!enabled || !row) return null;
    const work = row.read();
    if (!work) return null;
    let code = row.code;
    let lossSequence = row.lossSequence;
    let fence: 'owner-retired' | 'verified-ledger' | null = row.retired ? 'owner-retired' : null;
    let requesterInstance: string | undefined;
    let authorityLength = 0;
    let authorityGeneration = 0;
    if (requesterDevice !== undefined) {
      let requester = row.requesters.get(requesterDevice);
      const authority = row.readAuthority?.(requesterDevice, requester?.membershipId);
      if (!authority) return null;
      if (!requester) {
        // Register only an existing verified identity. A random already-absent
        // key cannot impersonate the client whose revocation is being tested.
        if (!authority.devicePresent || !authority.memberPresent || !authority.membershipId)
          return null;
        requester = {
          requesterInstance: randomUUID(),
          membershipId: authority.membershipId,
          ownerMembershipId: authority.ownerMembershipId,
          baselineLength: authority.length,
          baselineGeneration: authority.generation,
          lossSequence: 0,
        };
        row.requesters.set(requesterDevice, requester);
      }
      requesterInstance = requester.requesterInstance;
      authorityLength = authority.length;
      authorityGeneration = authority.generation;
      const ledgerCut =
        authority.length > requester.baselineLength &&
        authority.generation > requester.baselineGeneration &&
        (!authority.devicePresent || !authority.memberPresent);
      const retiredMember =
        row.code === 'e2ee_member_removed' &&
        row.retired &&
        requester.membershipId === requester.ownerMembershipId;
      code = ledgerCut
        ? !authority.memberPresent
          ? 'e2ee_member_removed'
          : 'e2ee_device_revoked'
        : retiredMember
          ? 'e2ee_member_removed'
          : null;
      fence = ledgerCut ? 'verified-ledger' : retiredMember ? 'owner-retired' : null;
      if (code && requester.lossSequence === 0) {
        requester.lossSequence = sequence + 1;
        changed();
      }
      lossSequence = requester.lossSequence;
    }
    const pending = {
      ...work.pending,
      executionBookkeeping:
        work.pending.executionBookkeeping + (rawWork.get(workspaceId)?.size ?? 0),
    };
    const drained =
      code !== null &&
      !row.failed &&
      fence !== null &&
      (fence === 'verified-ledger' || work.intakeClosed) &&
      Object.values(pending).every((count) => count === 0);
    return {
      version: 1 as const,
      pid,
      processInstance,
      sequence,
      ...{
        machineId: row.machineId,
        accountId: row.accountId,
        workspaceId,
        ownerInstance: row.ownerInstance,
        lossSequence,
        code,
        retired: row.retired,
        drained,
        requesterInstance,
        authorityLength,
        authorityGeneration,
        fence,
        status: row.failed
          ? ('failed' as const)
          : drained
            ? ('drained' as const)
            : code
              ? ('retiring' as const)
              : ('active' as const),
        pending,
      },
    };
  };
  return {
    enabled,
    changed,
    inspect,
    trackRaw(workspaceId: string, request: Promise<unknown>): void {
      if (!enabled) return;
      let tasks = rawWork.get(workspaceId);
      if (!tasks) {
        tasks = createDaemonLossTasks(true, changed);
        rawWork.set(workspaceId, tasks);
      }
      void tasks.track(request);
    },
    register(scope: Scope, read: () => DaemonLossWork | null, readAuthority?: ReadAuthority) {
      if (!enabled) return undefined;
      const row = {
        ...scope,
        ownerInstance: randomUUID(),
        lossSequence: 0,
        code: null as DaemonLossCode | null,
        retired: false,
        failed: false,
        read,
        readAuthority,
        requesters: new Map<string, Requester>(),
      };
      rows.set(scope.workspaceId, row);
      changed();
      return {
        loss(code: DaemonLossCode) {
          if (!row.code) {
            row.code = code;
            row.lossSequence = sequence + 1;
            changed();
          }
        },
        retired() {
          row.retired = true;
          changed();
        },
        failed() {
          row.failed = true;
          changed();
        },
      };
    },
    wait(
      workspaceId: string,
      afterSequence: number,
      signal?: AbortSignal,
      timeoutMs = 30_000,
      requesterDevice?: string
    ) {
      return new Promise<NonNullable<ReturnType<typeof inspect>>>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const initialOwner = rows.get(workspaceId)?.ownerInstance;
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(check);
          signal?.removeEventListener('abort', aborted);
        };
        const fail = (code: string) => {
          cleanup();
          reject(new Error(code));
        };
        const aborted = () => fail('daemon_loss_aborted');
        const check = () => {
          try {
            if (rows.get(workspaceId)?.ownerInstance !== initialOwner)
              return fail('daemon_loss_owner_changed');
            const value = inspect(workspaceId, requesterDevice);
            if (!value) return fail('daemon_loss_missing');
            if (
              value.status === 'failed' ||
              (value.lossSequence > afterSequence && value.drained)
            ) {
              cleanup();
              resolve(value);
            }
          } catch {
            fail('daemon_loss_unavailable');
          }
        };
        if (signal?.aborted) {
          aborted();
          return;
        }
        timer = setTimeout(() => fail('daemon_loss_deadline'), timeoutMs);
        listeners.add(check);
        signal?.addEventListener('abort', aborted, { once: true });
        check();
      });
    },
  };
}

export const daemonLossObserver = createDaemonLossRegistry(daemonLossProbeEnabled);

/** Original promises survive clearing the product's session maps on stop(). */
export function createDaemonLossTasks(
  enabled = daemonLossProbeEnabled,
  changed = daemonLossObserver.changed
) {
  const tasks = enabled ? new Set<Promise<unknown>>() : null;
  return {
    get size() {
      return tasks?.size ?? 0;
    },
    track<T>(work: Promise<T>): Promise<T> {
      if (!tasks) return work;
      tasks.add(work);
      changed();
      const settled = () => {
        tasks.delete(work);
        changed();
      };
      void work.then(settled, settled);
      return work;
    },
  };
}
