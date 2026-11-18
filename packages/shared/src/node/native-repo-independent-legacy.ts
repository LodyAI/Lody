import { randomUUID } from 'node:crypto';
import { Cause, Effect, Exit, Layer } from 'effect';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { makeApplicationRuntime } from './application-runtime';
import {
  ProcessReleaseFailed,
  processLayer,
  squashProcessFailure,
  type ProcessFacadeOptions,
} from './process';
import {
  IndependentNativeRepo,
  IndependentRepoLeaseReleaseFailed,
  independentNativeRepoLayer,
  type IndependentNativeRepoOptions,
  type IndependentNativeRepoLease,
} from './native-repo-independent-host';

const ownedReleases = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) => {
    if (!Cause.isDieReason(reason)) return [];
    return reason.defect instanceof ProcessReleaseFailed ||
      reason.defect instanceof IndependentRepoLeaseReleaseFailed
      ? [reason.defect]
      : [];
  });

/** Complete Cause and every transferred process/control recovery owner survive this Promise boundary. */
export class IndependentRepoOwnerFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super('Independent native Repo owner failed', { cause: squashProcessFailure(effectCause) });
  }
}

const recoverReleases = (cause: Cause.Cause<unknown>, requireOwner: boolean) => {
  const releases = [...new Set(ownedReleases(cause))];
  if (releases.length === 0) return requireOwner ? Effect.failCause(cause) : Effect.void;
  return Effect.forEach(
    releases,
    (release) =>
      release instanceof ProcessReleaseFailed
        ? release.retryTermination()
        : Effect.tryPromise({ try: release.retryCleanup, catch: (error) => error }),
    { discard: true }
  );
};

function makeOwner(options: IndependentNativeRepoOptions, platform: ProcessFacadeOptions) {
  return {
    application: makeApplicationRuntime(
      independentNativeRepoLayer(options).pipe(Layer.provide(processLayer(platform))),
      {
        project: (cause) => new IndependentRepoOwnerFailure(cause),
        recover: (cause) => recoverReleases(cause, true),
      }
    ),
    acquisitionFailure: undefined as Cause.Cause<unknown> | undefined,
  };
}
type Owner = ReturnType<typeof makeOwner>;
type Current = {
  owner: Owner;
  lease: IndependentNativeRepoLease;
  lost: boolean;
  clientGeneration: string;
};
export type IndependentRepoLeaseInfo = {
  readonly engineRunId: string;
  readonly controlId: string;
  readonly sdkArtifactId?: string;
  readonly pid: number;
  /** Changes on SDK socket replacement even when the independent engine stays alive. */
  readonly clientGeneration: string;
};

/**
 * @deprecated Shared composition boundary for main/daemon Promise owners.
 * Delete after both consumers compose the native Layer in their application Scope.
 * This facade never replays mutations or changes the persistent owner mode.
 */
export class IndependentNativeRepoHostLegacy {
  private current: Current | undefined;
  private inflight: Promise<Current> | undefined;
  private closeInFlight: Promise<void> | undefined;
  private closed = false;
  private retirement: Promise<void> | undefined;
  private retirementTarget: Current | undefined;
  private workspaceRetired = false;
  private readonly retired = new Set<Owner>();

  constructor(
    private readonly options: IndependentNativeRepoOptions,
    private readonly platform: ProcessFacadeOptions = {}
  ) {}

  async client(): Promise<RepoClient> {
    return (await this.acquire()).lease.client;
  }

  async leaseInfo(expectedClient?: RepoClient): Promise<IndependentRepoLeaseInfo> {
    const current = await this.acquire();
    if (expectedClient && expectedClient !== current.lease.client)
      throw new Error('Independent native Repo client generation changed');
    return {
      engineRunId: current.lease.engineRunId,
      controlId: current.lease.controlId,
      ...(current.lease.sdkArtifactId ? { sdkArtifactId: current.lease.sdkArtifactId } : {}),
      pid: current.lease.pid,
      clientGeneration: current.clientGeneration,
    };
  }

  private acquire(): Promise<Current> {
    if (this.closed)
      return Promise.reject(new Error('Independent native Repo composition is closed'));
    if (
      this.current &&
      !this.current.lost &&
      this.current.lease.client.connectionState === 'connected'
    ) {
      return Promise.resolve(this.current);
    }
    if (this.inflight) return this.inflight;
    let attempt: Promise<Current>;
    attempt = this.replace().finally(() => {
      if (this.inflight === attempt) this.inflight = undefined;
    });
    this.inflight = attempt;
    return attempt;
  }

  private async replace(): Promise<Current> {
    // Bound retained generations to the current lease plus one failed retirement.
    // A healthy current SDK client remains usable while that cleanup is retried.
    await this.cleanupRetired();
    if (this.closed) throw new Error('Independent native Repo composition is closed');
    const owner = makeOwner(this.options, this.platform);
    const acquired = await owner.application.runtime.runPromiseExit(IndependentNativeRepo, {
      signal: this.platform.signal,
    });
    if (Exit.isFailure(acquired)) {
      owner.acquisitionFailure = acquired.cause;
      const failure = new IndependentRepoOwnerFailure(acquired.cause);
      try {
        await this.closeOwner(owner);
      } catch (release) {
        throw new AggregateError(
          [failure, release],
          'Independent native Repo acquisition and release failed'
        );
      }
      throw failure;
    }
    const next: Current = {
      owner,
      lease: acquired.value,
      lost: false,
      clientGeneration: randomUUID(),
    };
    void owner.application.runtime.runPromiseExit(next.lease.lost).then(() => {
      next.lost = true;
    });
    if (this.closed) {
      await this.closeOwner(owner);
      throw new Error('Independent native Repo composition is closed');
    }
    const previous = this.current;
    this.current = next;
    // Acquire the replacement lease first. A socket flap must not turn the old
    // lease's release into a last-lease stop of an otherwise healthy data host.
    if (previous) await this.closeOwner(previous.owner);
    return next;
  }

  private async closeOwner(owner: Owner): Promise<void> {
    this.retired.add(owner);
    await owner.application.closeLegacy();
    if (owner.acquisitionFailure) {
      const recovered = await Effect.runPromiseExit(
        recoverReleases(owner.acquisitionFailure, false)
      );
      if (Exit.isFailure(recovered))
        throw new IndependentRepoOwnerFailure(
          Cause.combine(owner.acquisitionFailure, recovered.cause)
        );
      owner.acquisitionFailure = undefined;
    }
    this.retired.delete(owner);
  }

  private async cleanupRetired(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.retired].map((owner) => this.closeOwner(owner))
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length)
      throw new AggregateError(failures, 'Independent native Repo retirement remains unconfirmed');
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closeInFlight) return this.closeInFlight;
    let closing: Promise<void>;
    closing = (async () => {
      if (this.inflight) await Promise.allSettled([this.inflight]);
      if (this.current) {
        this.retired.add(this.current.owner);
        this.current = undefined;
      }
      await this.cleanupRetired();
    })().finally(() => {
      if (this.closeInFlight === closing) this.closeInFlight = undefined;
    });
    this.closeInFlight = closing;
    return closing;
  }

  /** Trusted Node whole-workspace owner only. Ordinary observer close remains
   * last-lease based. Never reacquires a client or discovers a successor run. */
  retireWorkspace(expectedClient: RepoClient): Promise<void> {
    const current = this.retirementTarget ?? this.current;
    if (!current || current.lease.client !== expectedClient)
      return Promise.reject(new Error('Independent native Repo retirement generation changed'));
    if (this.retirement) return this.retirement;
    this.retirementTarget = current;
    this.closed = true;
    current.lost = true;
    let attempt: Promise<void>;
    attempt = (async () => {
      if (!this.workspaceRetired) {
        // The captured retirement Effect has no application environment. Its
        // original Scope may already be released while a foreign lease lives.
        const result = await Effect.runPromiseExit(current.lease.retireWorkspace);
        if (Exit.isFailure(result)) throw new IndependentRepoOwnerFailure(result.cause);
        this.workspaceRetired = true;
      }
      await this.close();
    })().finally(() => {
      if (this.retirement === attempt) this.retirement = undefined;
    });
    this.retirement = attempt;
    return attempt;
  }

  /** Retry retained cleanup without admitting another application generation. */
  async retryCleanup(): Promise<void> {
    if (this.closed) return await this.close();
    await this.cleanupRetired();
  }
}
