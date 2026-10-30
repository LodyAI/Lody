import { useEffect } from 'react';
import type { E2eeWorkspaceRuntime } from '@lody/platform';

type Runtime = Pick<E2eeWorkspaceRuntime, 'status' | 'memberJoinRequests' | 'approveMemberJoin'> &
  Partial<Pick<E2eeWorkspaceRuntime, 'open' | 'close' | 'refresh'>>;
const opening = new WeakMap<Runtime, Promise<void>>();
function queueOpen<T>(runtime: Runtime, work: () => Promise<T>) {
  const next = (opening.get(runtime) ?? Promise.resolve()).then(work);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  opening.set(runtime, tail);
  void tail.then(() => {
    if (opening.get(runtime) === tail) opening.delete(runtime);
  });
  return next;
}

/** One owned, serial poll; a bad applicant never prevents the next applicant. */
export function startEmailAdmissionWorker(
  runtime: Runtime,
  workspaceId: string,
  accountId?: string
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped || running || !runtime.memberJoinRequests || !runtime.approveMemberJoin) return;
    running = true;
    clearTimeout(timer);
    let release: (() => Promise<void>) | undefined;
    try {
      if (accountId && runtime.open && runtime.close) {
        const owned = await queueOpen(runtime, () =>
          stopped ? Promise.resolve(null) : runtime.open!(workspaceId, undefined, accountId)
        );
        if (!owned) return;
        release = () => runtime.close!(workspaceId, accountId, owned.readerOwner);
      }
      if (stopped) return;
      // Eligibility must recover from an initial offline refresh or later role change.
      if (runtime.refresh) await runtime.refresh(workspaceId, { installKeys: false });
      const status = await runtime.status(workspaceId);
      if (
        stopped ||
        status.deviceKind !== 'personal' ||
        !['owner', 'admin'].includes(status.memberRole ?? '')
      )
        return;
      const requests = await runtime.memberJoinRequests(workspaceId);
      for (const request of requests.items) {
        if (stopped) break;
        if (request.source !== 'email') continue;
        try {
          await runtime.approveMemberJoin(workspaceId, request.requestId, 'automatic');
        } catch {
          /* The host retains original bytes; another applicant can continue. */
        }
      }
    } catch {
      /* Offline/auth/key failures stay within this worker and retry on reconnect. */
    } finally {
      try {
        await release?.();
      } catch {
        /* A failed release stays native-owned. */
      }
      running = false;
      if (!stopped) timer = setTimeout(() => void run(), 10_000);
    }
  };
  const online = () => void run();
  window.addEventListener('online', online);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('online', online);
  };
}

export function EmailAdmissionWorker(props: { runtime: Runtime; workspaceId: string }) {
  useEffect(
    () => startEmailAdmissionWorker(props.runtime, props.workspaceId),
    [props.runtime, props.workspaceId]
  );
  return null;
}

export function E2eeTeamInboxHost({
  runtime,
  workspaceId,
  accountId,
}: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  accountId: string;
}) {
  useEffect(
    () => startEmailAdmissionWorker(runtime, workspaceId, accountId),
    [runtime, workspaceId, accountId]
  );
  return null;
}
