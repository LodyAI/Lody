import { Effect } from 'effect';
import type {
  LocalWorkspaceCatalogService,
  LocalWorkspaceCatalogSnapshot,
} from '@/lib/local-workspace-catalog';
import type { MachineAccessDenyReason } from './session-access-retry';

export type SessionAccessPolicyDecision =
  | { outcome: 'allow'; source: 'owner-cached' }
  | {
      outcome: 'deny';
      reason: MachineAccessDenyReason;
      source: 'remote_missing';
    }
  | { outcome: 'remote' };

export type SessionAccessPolicyInput = {
  workspaceId: string;
  currentUserId: string;
  requesterUserId: string;
};

export type SessionAccessPolicyService = {
  // Never fails: catalog trouble degrades to `{ outcome: 'remote' }` (see
  // makeSessionAccessPolicy) instead of stranding the dispatch check.
  decide: (input: SessionAccessPolicyInput) => Effect.Effect<SessionAccessPolicyDecision>;
};

const LOCAL_POLICY_DENY_REASON: MachineAccessDenyReason = 'not_visible';

export function decideSessionAccessFromCatalog(
  snapshot: LocalWorkspaceCatalogSnapshot,
  input: SessionAccessPolicyInput
): SessionAccessPolicyDecision {
  const workspace = snapshot.workspaces.find((item) => item.workspaceId === input.workspaceId);
  if (!workspace) {
    return { outcome: 'remote' };
  }

  // The whole catalog (workspace states and snapshots) was written under the
  // cached identity. If the CLI now runs as a different user, none of it may be
  // reused — fall through to the remote three-state check instead of consuming
  // another account's cached verdicts.
  if (snapshot.identity?.userId !== input.currentUserId) {
    return { outcome: 'remote' };
  }

  // `remote_missing` is derived fresh from every reconcile (the workspace fell out
  // of the remote list), not a cached verdict, so it self-heals when the workspace
  // reappears — safe to deny offline.
  if (workspace.state === 'remote_missing') {
    return { outcome: 'deny', reason: LOCAL_POLICY_DENY_REASON, source: 'remote_missing' };
  }

  // Optimistic-allow cache: the ONLY thing the cache can grant is an owner-cached
  // allow. Anything else (no snapshot, owner mismatch, foreign requester) falls
  // through to a fresh remote check rather than a durable local deny. Offline this
  // becomes `indeterminate` → the turn stays pending (and retries) instead of
  // being permanently failed by a possibly-stale cached verdict.
  const accessSnapshot = workspace.accessSnapshot;
  if (!accessSnapshot) {
    return { outcome: 'remote' };
  }

  if (accessSnapshot.ownerUserId !== input.currentUserId) {
    return { outcome: 'remote' };
  }

  if (input.requesterUserId !== input.currentUserId) {
    return { outcome: 'remote' };
  }

  return { outcome: 'allow', source: 'owner-cached' };
}

export function makeSessionAccessPolicy(
  catalog: LocalWorkspaceCatalogService
): SessionAccessPolicyService {
  return {
    decide: (input) =>
      catalog.read().pipe(
        Effect.map((snapshot) => decideSessionAccessFromCatalog(snapshot, input)),
        // Missing/corrupt catalogs already self-recover inside read(). Anything
        // that still fails (e.g. EACCES on ~/.lody) must not strand the turn in
        // a dispatch check that errors forever: degrade to the remote
        // three-state verification, which is the no-catalog behavior anyway.
        Effect.catch(() => Effect.succeed<SessionAccessPolicyDecision>({ outcome: 'remote' }))
      ),
  };
}
