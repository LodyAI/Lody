import { Context, Effect, Layer } from 'effect';
import type { Logger } from '@/utils/logger';
import type { PrPollerConfig } from './pr-poller-config';
import type { PrPollerStateStore } from './pr-poller-state';
import { GitHubGraphQlClient } from './github-graphql-client';
import { PrPollScheduler, type PrPollSchedulerCounters } from './pr-poll-scheduler';
import type { PrPollerWorkspaceHandle } from './pr-poller-workspace';

/**
 * `PrStatusPoller` — fleet-level daemon service that reconciles PR
 * lifecycle + CI rollup + merge/conflict state for this machine's sessions
 * via batched GitHub GraphQL (spec `specs/pr-status-reconciler.md`).
 *
 * Constructed in `LodyFleet.start()`, stopped in `shutdown()`; workspace
 * runtimes register/unregister as they come and go (they are fact sources
 * and write-back destinations — nothing more). Priority comes from viewing
 * presence and `lastMessageAt` activity; there is no turn-end hook. The
 * Effect Tag/Layer is the service definition; `start`/`stop`/`isStarted`
 * are Effects, while the fleet-facing wiring methods are plain boundary
 * calls (the fleet is not Effect-based — interop per
 * `context/cli-effect-ts.md`).
 */
export interface PrStatusPollerShape {
  readonly config: PrPollerConfig;
  readonly stateStore: PrPollerStateStore;
  /** Idempotent. A disabled poller (`LODY_PR_POLL_DISABLED=1`) stays stopped. */
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly isStarted: Effect.Effect<boolean>;
  /** Register a running workspace runtime; no-op when disabled/stopped. */
  registerWorkspace(handle: PrPollerWorkspaceHandle): void;
  unregisterWorkspace(workspaceId: string): void;
  /** Observability counters. */
  counters(): PrPollSchedulerCounters;
}

export class PrStatusPoller extends Context.Service<PrStatusPoller, PrStatusPollerShape>()(
  'lody/PrStatusPoller'
) {}

export type PrStatusPollerDeps = {
  config: PrPollerConfig;
  stateStore: PrPollerStateStore;
  logger: Logger;
  /** Injectable for tests; defaults to a real client tuned by config. */
  client?: Pick<GitHubGraphQlClient, 'executeBatch'>;
  nowMs?: () => number;
};

export const makePrStatusPoller = (deps: PrStatusPollerDeps): PrStatusPollerShape => {
  const scheduler = new PrPollScheduler({
    config: deps.config,
    stateStore: deps.stateStore,
    logger: deps.logger,
    client:
      deps.client ??
      new GitHubGraphQlClient({
        logger: deps.logger,
        timeoutMs: deps.config.fetchTimeoutMs,
        concurrency: deps.config.fetchConcurrency,
      }),
    ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
  });

  // Single-fiber lifecycle (fleet start/shutdown) — a plain flag suffices.
  let started = false;

  const start = Effect.sync(() => {
    if (started) {
      return;
    }
    if (!deps.config.enabled) {
      deps.logger.debug('[pr-poller] PR status poller is disabled (LODY_PR_POLL_DISABLED)');
      return;
    }
    started = true;
    deps.logger.debug(
      `[pr-poller] Starting PR reconciler (high=${deps.config.highIntervalMs}ms, ` +
        `lowStatus=${deps.config.lowStatusIntervalMs}ms, lowDiscovery=${deps.config.lowDiscoveryIntervalMs}ms, ` +
        `bucket=${deps.config.bucketCapacityPoints}pts+${deps.config.bucketRefillPointsPerMinute}/min)`
    );
    scheduler.start();
  });

  const stop = Effect.sync(() => {
    if (!started) {
      return;
    }
    started = false;
    scheduler.stop();
    deps.logger.debug('[pr-poller] PR status poller stopped');
  });

  return {
    config: deps.config,
    stateStore: deps.stateStore,
    start,
    stop,
    isStarted: Effect.sync(() => started),
    registerWorkspace: (handle) => {
      if (started) {
        scheduler.registerWorkspace(handle);
      } else if (deps.config.enabled) {
        // Ordering bug guard: an enabled poller must be started before
        // workspace runtimes connect (see LodyFleet.start). A dropped
        // registration silently disables all polling for that workspace.
        deps.logger.warn(
          `[pr-poller] registerWorkspace(${handle.workspaceId}) before start — registration dropped`
        );
      }
    },
    unregisterWorkspace: (workspaceId) => scheduler.unregisterWorkspace(workspaceId),
    counters: () => scheduler.counters,
  };
};

export const layerPrStatusPoller = (deps: PrStatusPollerDeps): Layer.Layer<PrStatusPoller> =>
  Layer.succeed(PrStatusPoller, makePrStatusPoller(deps));
