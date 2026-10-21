import type { ProcessTableSnapshot } from '@/monitor/process-table';
import { Context, Effect } from 'effect';

export type InboxResourceIdentity = {
  platform: NodeJS.Platform;
  roots: readonly number[];
  /** False (including legacy absence) while resource acquisition is unaccounted for. */
  complete?: boolean;
};
export type BlockedInboxExecution = {
  scope: { workspaceId: string; sessionId: string; userId: string };
  executionId: string | null;
  identity?: InboxResourceIdentity;
  /** Opaque compare-and-swap identity, not an execution ID or proof of release. */
  snapshotToken: string;
  resources: {
    executionId: string;
    userId: string;
    identity?: InboxResourceIdentity;
  }[];
  reason:
    | 'missing_identity'
    | 'incomplete_identity'
    | 'resources_unreleased'
    | 'missing_active_execution'
    | 'ambiguous_ownership';
};
/** Operator attestation covers absent identities; this only checks the recorded evidence. */
export const knownOperatorResourcesGone = (
  record: BlockedInboxExecution,
  platform: NodeJS.Platform,
  snapshot: ProcessTableSnapshot
): boolean =>
  snapshot.warnings.length === 0 &&
  record.resources.every(
    (resource) =>
      !resource.identity ||
      (resource.identity.platform === platform &&
        resource.identity.roots.every(
          (pid) =>
            !snapshot.entries.some((entry) => entry.pid === pid || entry.processGroupId === pid)
        ))
  );

/** Read-only verification. Never send a signal to a PID that may have been reused. */
export const provesResourcesGone = (
  identity: InboxResourceIdentity,
  snapshot: ProcessTableSnapshot
): boolean =>
  identity.platform !== 'win32' &&
  identity.complete === true &&
  identity.roots.length > 0 &&
  identity.roots.every(
    (pid) => !snapshot.entries.some((entry) => entry.pid === pid || entry.processGroupId === pid)
  );

export class InboxRecoveryProbe extends Context.Service<
  InboxRecoveryProbe,
  {
    released(identity: InboxResourceIdentity): Effect.Effect<boolean, unknown>;
  }
>()('lody/orchestration/InboxRecoveryProbe') {}
