/** Actual resources selected by one provider lifetime. These labels route cleanup; they never authorize access. */
export interface WorkspaceRuntimeResources {
  readonly native?: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly genesisHash: string;
    readonly signingPublicKey?: string;
  };
  readonly repo?: {
    readonly workspaceId: string;
    readonly identity?: {
      readonly accountId: string;
      readonly genesisHash: string;
      readonly signingPublicKey: string;
    };
  };
}
interface Retirement {
  readonly resources: () => WorkspaceRuntimeResources;
  readonly dispose: () => Promise<void>;
  flight?: Promise<void>;
  failure?: unknown;
}
function overlaps(left: WorkspaceRuntimeResources, right: WorkspaceRuntimeResources): boolean {
  // Custody's physical writer is shared across device replacements in this binding.
  if (
    left.native &&
    right.native &&
    left.native.accountId === right.native.accountId &&
    left.native.workspaceId === right.native.workspaceId &&
    left.native.genesisHash === right.native.genesisHash
  )
    return true;
  if (!left.repo || !right.repo || left.repo.workspaceId !== right.repo.workspaceId) return false;
  const a = left.repo.identity;
  const b = right.repo.identity;
  // Ordinary databases are workspace-scoped; protected databases include the identity.
  if (!a || !b) return !a && !b;
  return (
    a.accountId === b.accountId &&
    a.genesisHash === b.genesisHash &&
    a.signingPublicKey === b.signingPublicKey
  );
}
/** Keep unfinished owners across route changes; only actual successful close removes one. */
export function createWorkspaceRuntimeRetirements() {
  const retained = new Set<Retirement>();
  const close = (entry: Retirement): Promise<void> => {
    if (entry.flight) return entry.flight;
    const pending = Promise.resolve().then(entry.dispose);
    entry.flight = pending;
    void pending.then(
      () => {
        retained.delete(entry);
        entry.failure = undefined;
      },
      (error) => {
        entry.failure = error;
        if (entry.flight === pending) entry.flight = undefined;
      }
    );
    return pending;
  };
  return {
    create: (
      resources: () => WorkspaceRuntimeResources,
      dispose: () => Promise<void>
    ): Retirement => ({ resources, dispose }),
    retire: async (entry: Retirement): Promise<void> => {
      retained.add(entry);
      await close(entry);
      // The same effect may retire provisionally and again during React cleanup.
      retained.delete(entry);
    },
    async drain(target: WorkspaceRuntimeResources): Promise<void> {
      const selected = [...retained].filter((entry) => overlaps(entry.resources(), target));
      const outcomes = await Promise.allSettled(selected.map(close));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Workspace retirement incomplete');
    },
  };
}
