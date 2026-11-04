import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { buildWorkspaceWatchWorkerEnvironment } from './workspace-watch-coordinator';

describe('WorkspaceWatchCoordinator', () => {
  it('does not forward representative credentials or NODE_OPTIONS', () => {
    expect(
      buildWorkspaceWatchWorkerEnvironment({
        PATH: '/bin',
        LANG: 'en_US.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        GH_TOKEN: 'secret',
        LODY_SUPERVISOR_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
      })
    ).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
