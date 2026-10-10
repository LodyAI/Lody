import { probeLoginShellEnvLegacy } from '@lody/shared/node/login-shell-env';

import { toShared } from '@/platform/process-options';
import { getLogger } from '@/utils/logger';

/**
 * How long an ACP spawn waits for the probe before going ahead without it. The
 * probe itself keeps its own bound (shared with the desktop) and ends the
 * shell's whole process tree when it runs out. Failed release retains its owner.
 */
const SHELL_ENV_WAIT_MS = 3000;

/**
 * Resolving the login-shell env spawns the user's shell with `-ilc` so it sources
 * their full profile. That is slow (~100-300ms) but the result does not change
 * mid-session, so memoize the first resolution for the process lifetime.
 */
let cachedShellEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;
/** Last successfully resolved env, exposed to synchronous callers. */
let resolvedShellEnv: NodeJS.ProcessEnv = {};
/** The compatibility cache retains failed probe/resource ownership for later readers. */
let retainedProbeFailure: { readonly error: unknown } | null = null;

const shouldSkip = (): boolean => process.env.LODY_DISABLE_SHELL_ENV === '1';

const resolveOnce = (): Promise<NodeJS.ProcessEnv> => {
  const probe = probeLoginShellEnvLegacy({ processOptions: toShared() })
    .then((probed) => {
      const env = probed ?? {};
      resolvedShellEnv = env;
      // The race below may have already resolved the memoized promise to {} via
      // the timeout. Replace it so *later* awaiters (acp-runner aux sessions,
      // history-sync) get the real env instead of being stuck on the timeout's
      // empty overlay for the rest of the process — otherwise the sync accessor
      // (which reads resolvedShellEnv) and the async accessor would permanently
      // disagree after a slow-but-successful probe.
      cachedShellEnvPromise = Promise.resolve(env);
      return env;
    })
    .catch((error: unknown): never => {
      retainedProbeFailure = { error };
      cachedShellEnvPromise = Promise.reject(error);
      // Observe the rejection without replacing the cached failure or its leases.
      void cachedShellEnvPromise.catch(() => undefined);
      getLogger().error('Login-shell probe failed; retaining its failure for launchers', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    });

  // A slow rc file must not hold every awaiting ACP spawn for the probe's
  // whole bound. Fail open to the empty overlay so the
  // withDefaultAcpPathEntries fallback still applies; the probe keeps running
  // and replaces the cached value when it finishes.
  const timeout = new Promise<NodeJS.ProcessEnv>((resolve) => {
    const timer = setTimeout(() => resolve({}), SHELL_ENV_WAIT_MS);
    timer.unref();
  });

  return Promise.race([probe, timeout]);
};

/**
 * Read the environment (most importantly `PATH`) from the user's login shell
 * profile.
 *
 * GUI/daemon launches (Electron Dock, systemd, npx, IDE terminals) inherit a
 * minimal PATH that omits the dirs users actually install tools into
 * (`~/.local/bin`, homebrew, cargo, volta, asdf, ...). Spawning an agent binary
 * such as `opencode acp` then fails with `spawn opencode ENOENT`. The shared
 * probe (`@lody/shared/node/login-shell-env`, also used by the desktop) runs the
 * login shell, so we pick up tools wherever they live instead of guessing a
 * fixed set of directories.
 *
 * Expected absent/unsupported shells yield `{}`; failed probes reject with their retained error. The
 * overlay is the login shell's whole environment, which stays safe because
 * `mergeLoginShellEnv` is base-wins for non-PATH vars (a no-op for vars the
 * base already has) and the caller scrubs inherited auth/routing vars *after*
 * overlaying (see session.ts). Disable entirely via `LODY_DISABLE_SHELL_ENV=1`.
 */
/** @deprecated The cache owner remains Promise-based; native callers use LoginShellEnvironment. */
export const getLoginShellEnvLegacy = async (): Promise<NodeJS.ProcessEnv> => {
  if (shouldSkip()) {
    return {};
  }
  if (!cachedShellEnvPromise) {
    cachedShellEnvPromise = resolveOnce();
  }
  return cachedShellEnvPromise;
};

/**
 * Synchronous view of the login-shell env for callers that cannot await, such as
 * terminal-manager environment callbacks. Returns `{}` until
 * `getLoginShellEnvLegacy()` has resolved at least once, so the first read kicks off
 * resolution and relies on the `withDefaultAcpPathEntries` fallback for that one
 * call; later reads see the cached env. ACP startup awaits the async accessor.
 */
/** @deprecated Explicitly synchronous, pending-compatible cache access. */
export const getCachedLoginShellEnvSyncLegacy = (): NodeJS.ProcessEnv => {
  if (shouldSkip()) {
    return {};
  }
  if (retainedProbeFailure) throw retainedProbeFailure.error;
  if (!cachedShellEnvPromise) {
    // The Legacy cache records and reports failed background probing.
    void getLoginShellEnvLegacy().catch(() => undefined);
  }
  return resolvedShellEnv;
};

/** Test-only: clear the memoized login-shell env so cases can re-resolve. */
/** @deprecated Test-only reset of the remaining Legacy cache. */
export const resetLoginShellEnvCacheLegacy = (): void => {
  cachedShellEnvPromise = null;
  resolvedShellEnv = {};
  retainedProbeFailure = null;
};
