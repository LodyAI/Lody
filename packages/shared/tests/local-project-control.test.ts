import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  isLocalProjectControlRequest,
  isLocalProjectControlResponse,
} from '../src/node/local-project-control';

const require = createRequire(import.meta.url);
const cjs = require('../src/node/local-project-control.cjs') as {
  isLocalProjectControlRequest: (value: unknown) => boolean;
  isLocalProjectControlResponse: (value: unknown) => boolean;
};

const guards = [
  ['ts', { isLocalProjectControlRequest, isLocalProjectControlResponse }],
  ['cjs', cjs],
] as const;

const scope = { machineId: 'machine-1', workspaceId: 'workspace-1' };

describe.each(guards)('local project control %s guards', (_name, guard) => {
  it('admits host-side file search and its result', () => {
    expect(
      guard.isLocalProjectControlRequest({
        ...scope,
        type: 'local-project/search-files',
        localProjectId: 'lp-1',
        query: 'button',
        limit: 50,
      })
    ).toBe(true);
    expect(
      guard.isLocalProjectControlRequest({
        ...scope,
        type: 'local-project/search-files',
        localProjectId: 'lp-1',
      })
    ).toBe(false);
    expect(
      guard.isLocalProjectControlResponse({
        ok: true,
        type: 'local-project/search-files',
        result: { paths: ['src/button.tsx'], truncated: false },
      })
    ).toBe(true);
  });

  it('admits skill requests carrying a known fingerprint and unchanged answers', () => {
    expect(
      guard.isLocalProjectControlRequest({
        ...scope,
        type: 'local-project/list-skills',
        localProjectId: 'lp-1',
        skillDirs: ['.agents/skills'],
        knownFingerprint: 'fp',
      })
    ).toBe(true);
    expect(
      guard.isLocalProjectControlRequest({
        ...scope,
        type: 'local-project/list-global-skills',
        knownFingerprint: 'fp',
      })
    ).toBe(true);
    expect(
      guard.isLocalProjectControlRequest({
        ...scope,
        type: 'local-project/list-global-skills',
        knownFingerprint: 1,
      })
    ).toBe(false);
    expect(
      guard.isLocalProjectControlResponse({
        ok: true,
        type: 'local-project/list-global-skills',
        result: { groups: [], contentFingerprint: 'fp', unchanged: true },
      })
    ).toBe(true);
  });
});
