import { probeLoginShellEnv } from '@lody/shared/node/login-shell-env';

import { toShared } from '@/platform/promise-facade';

/**
 * How long an ACP spawn waits for the probe before going ahead without it. The
 * probe itself keeps its own bound (shared with the desktop) and ends the
 * shell's whole process tree when it runs out, so a hung rc file leaks nothing.
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

const shouldSkip = (): boolean => process.env.LODY_DISABLE_SHELL_ENV === '1';

const resolveOnce = (): Promise<NodeJS.ProcessEnv> => {
  const probe = probeLoginShellEnv({ processOptions: toShared() })
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
    .catch((): NodeJS.ProcessEnv => ({}));

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
 * Never throws: when no shell yields an environment the overlay is `{}`. The
 * overlay is the login shell's whole environment, which stays safe because
 * `mergeLoginShellEnv` is base-wins for non-PATH vars (a no-op for vars the
 * base already has) and the caller scrubs inherited auth/routing vars *after*
 * overlaying (see session.ts). Disable entirely via `LODY_DISABLE_SHELL_ENV=1`.
 */
export const getLoginShellEnv = async (): Promise<NodeJS.ProcessEnv> => {
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
 * `getLoginShellEnv()` has resolved at least once, so the first read kicks off
 * resolution and relies on the `withDefaultAcpPathEntries` fallback for that one
 * call; later reads see the cached env. ACP startup awaits the async accessor.
 */
export const getCachedLoginShellEnvSync = (): NodeJS.ProcessEnv => {
  if (shouldSkip()) {
    return {};
  }
  if (!cachedShellEnvPromise) {
    void getLoginShellEnv();
  }
  return resolvedShellEnv;
};

/** Test-only: clear the memoized login-shell env so cases can re-resolve. */
export const resetLoginShellEnvCache = (): void => {
  cachedShellEnvPromise = null;
  resolvedShellEnv = {};
};
