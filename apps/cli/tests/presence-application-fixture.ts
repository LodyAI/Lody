import { Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import { presencePlatformLayer } from '../src/platform/presence';
import { WorkspacePresenceOwnersLive } from '../src/lib/loro/workspace-presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
} from '../src/lib/loro/presence-legacy';
import type { Logger } from '../src/utils/logger';

/** Same application ownership as CLI startup; local tests never attach a cloud sink. */
export const bindTestPresenceApplication = (logger: Logger) => {
  const application = makeApplicationRuntime(
    WorkspacePresenceOwnersLive.pipe(Layer.provide(presencePlatformLayer(logger))),
    {
      recover: recoverCliPresenceApplicationShutdown,
      project: (cause) => new WorkspacePresenceLegacyFailure(cause),
    }
  );
  bindWorkspacePresenceApplicationLegacy(application);
  return application;
};
