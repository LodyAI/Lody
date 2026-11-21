import { Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import type { LoginShellCache } from '@lody/shared/node/login-shell-env';
import { presencePlatformLayer } from './platform/presence';
import { WorkspacePresenceOwnersLive } from './lib/loro/workspace-presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
} from './lib/loro/presence-legacy';
import type { Logger } from './utils/logger';

/**
 * The application owner of every command that can open a workspace document: the
 * login-shell cache plus Workspace presence. Kept out of the entry's static graph so
 * a process that composes no presence never evaluates the Loro/Flock wasm modules.
 */
export const makeCliPresenceApplication = (
  shellCache: Layer.Layer<LoginShellCache>,
  logger: Logger
) => {
  const application = makeApplicationRuntime(
    Layer.merge(
      shellCache,
      WorkspacePresenceOwnersLive.pipe(Layer.provide(presencePlatformLayer(logger)))
    ),
    {
      recover: recoverCliPresenceApplicationShutdown,
      project: (cause) => new WorkspacePresenceLegacyFailure(cause),
    }
  );
  bindWorkspacePresenceApplicationLegacy(application);
  return application;
};
