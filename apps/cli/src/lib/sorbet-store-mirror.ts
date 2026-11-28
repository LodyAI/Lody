/*
 * Mirrors the machine's Sorbet store into its Machine Flock as descriptors, so
 * a client without Machine RPC can draw its Providers.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openSorbetControl, type CustomProviderDefinition } from '@sorbetai/control';
import type {
  MachineId,
  SorbetMirrorModel,
  SorbetMirrorProvider,
  SorbetStoreMirror,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

import type { LoroDocumentManager } from '@/lib/loro/doc';

/**
 * How often a running daemon re-reads a store nothing asked about. Combined with
 * the immediate mirror after every RPC mutation, this bounds the staleness of a
 * change made outside Lody, which is what the row's `mirroredAt` tells a reader.
 */
export const SORBET_STORE_MIRROR_INTERVAL_MS = 5 * 60_000;

/** The Sorbet data directory this daemon's store lives in; machine-wide, like the store. */
export function getSorbetDataDirectory(): string {
  return join(getLodyDataDir(), 'sorbet');
}

/** A stored endpoint as the mirror row carries it; curated model fields stay Sorbet's. */
export function toSorbetMirrorProvider(provider: CustomProviderDefinition): SorbetMirrorProvider {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
    })),
  };
}

/**
 * One paid-for read of the whole store. All three families come from one control
 * handle so a single read cannot interleave a Provider list with a catalog that
 * already includes a Provider it does not (or the other way round).
 */
async function readSorbetStore(
  dataDirectory: string,
  signal?: AbortSignal
): Promise<SorbetStoreMirror> {
  const control = await openSorbetControl({ dataDirectory, signal });
  try {
    const credentials = await control.credentials.list({ signal });
    const providers = await control.providers.listCustom({ signal });
    const models = await control.providers.availableModels({ signal });
    return {
      credentials: credentials.map((credential) => ({
        providerId: credential.providerId,
        type: credential.type,
      })),
      providers: providers.map(toSorbetMirrorProvider),
      models: models.map((model): SorbetMirrorModel => ({
        selector: model.selector,
        providerId: model.providerId,
        modelId: model.modelId,
        displayName: model.displayName,
      })),
    };
  } finally {
    await control.close();
  }
}

export type SorbetStoreMirrorOptions = {
  document: Pick<LoroDocumentManager, 'writeSorbetStoreMirror'>;
  machineId: MachineId;
  /** Defaults to this daemon's own Sorbet data directory. */
  dataDirectory?: string;
  logger?: { warn: (message: string) => void; debug: (message: string) => void };
};

/**
 * Reads the machine's store and publishes it to this workspace's Machine Flock.
 * Resolves whether the rows changed. A store this machine never created is left
 * alone: opening control would create the directory and make every Lody machine
 * claim a Sorbet install it does not have.
 */
export function createSorbetStoreMirror(options: SorbetStoreMirrorOptions) {
  const dataDirectory = options.dataDirectory ?? getSorbetDataDirectory();
  return async function mirrorSorbetStore(signal?: AbortSignal): Promise<boolean> {
    if (!existsSync(dataDirectory)) return false;
    let mirror: SorbetStoreMirror;
    try {
      mirror = await readSorbetStore(dataDirectory, signal);
    } catch (error) {
      options.logger?.warn(`Sorbet store mirror failed to read: ${String(error)}`);
      return false;
    }
    return await options.document.writeSorbetStoreMirror(options.machineId, mirror);
  };
}

export type SorbetStoreMirrorLoop = {
  /** Re-reads the store once; concurrent callers share the run in flight. */
  refresh: () => Promise<boolean>;
  start: () => void;
  stop: () => void;
};

/**
 * The daemon's lifetime-bounded mirror: one read at start, then the periodic
 * probe. The timer is unref'd so a pending mirror can never hold the process
 * open, and `stop` makes the loop testable without leaking a timer into a test
 * run.
 */
export function startSorbetStoreMirrorLoop(
  options: SorbetStoreMirrorOptions
): SorbetStoreMirrorLoop {
  const run = createSorbetStoreMirror(options);
  let inFlight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = (): Promise<boolean> => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    refresh,
    start: () => {
      if (timer) return;
      void refresh().catch((error) => options.logger?.warn(String(error)));
      timer = setInterval(() => {
        void refresh().catch((error) => options.logger?.warn(String(error)));
      }, SORBET_STORE_MIRROR_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      options.logger?.debug('Sorbet store mirror stopped');
    },
  };
}
