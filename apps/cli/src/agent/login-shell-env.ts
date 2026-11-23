import { Effect, Exit } from 'effect';
import { LoginShellCache, LoginShellCacheClosed } from '@lody/shared/node/login-shell-env';
import type { ApplicationRuntime } from '@lody/shared/node/application-runtime';
import { squashProcessFailure } from '@lody/shared/node/process';

// This pointer bridges remaining Promise/synchronous launchers to the owner
// installed by the application entry. All cache state and work live in its Layer.
let application: ApplicationRuntime<LoginShellCache, never> | undefined;

/** @deprecated Application-entry binding for launchers awaiting native migration. */
export const bindLoginShellCacheLegacy = (
  owner: ApplicationRuntime<LoginShellCache, never>
): void => {
  if (application && !application.isReleased())
    throw new Error('Login-shell application owner already bound');
  application = owner;
};
const owner = () => {
  if (!application || application.isClosing()) throw new LoginShellCacheClosed();
  return application;
};

/** @deprecated Promise boundary; LoginShellCache owns the probe, wait and result. */
export const getLoginShellEnvLegacy = async (): Promise<NodeJS.ProcessEnv> => {
  if (process.env.LODY_DISABLE_SHELL_ENV === '1') return {};
  const exit = await owner().runtime.runPromiseExit(
    Effect.flatMap(LoginShellCache, (cache) => cache.get(3000))
  );
  if (Exit.isFailure(exit)) throw squashProcessFailure(exit.cause);
  return exit.value ?? {};
};

/** @deprecated Synchronous snapshot; a pending probe returns the empty overlay. */
export const getCachedLoginShellEnvSyncLegacy = (): NodeJS.ProcessEnv => {
  if (process.env.LODY_DISABLE_SHELL_ENV === '1') return {};
  const exit = owner().runtime.runSyncExit(Effect.flatMap(LoginShellCache, (cache) => cache.peek));
  if (Exit.isFailure(exit)) throw squashProcessFailure(exit.cause);
  return exit.value ?? {};
};

/** @deprecated Application exit boundary. Concurrent closes await the same receipt. */
export const closeLoginShellApplicationLegacy = (): Promise<void> =>
  application?.closeLegacy() ?? Promise.resolve();
