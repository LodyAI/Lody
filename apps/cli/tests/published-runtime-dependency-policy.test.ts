import { describe, expect, it } from 'vitest';
import {
  collectRuntimeDependencyVersionIssues,
  isExactSemverSpecifier,
} from '../scripts/published-runtime-dependency-policy.js';

describe('published runtime dependency policy', () => {
  it('accepts exact stable and prerelease semantic versions', () => {
    expect(isExactSemverSpecifier('1.15.1')).toBe(true);
    expect(isExactSemverSpecifier('1.2.0-beta.14')).toBe(true);
  });

  it.each(['^1.15.1', '~1.15.1', '>=1.15.1', 'workspace:^1.15.1'])(
    'rejects the non-exact specifier %s',
    (specifier) => {
      expect(isExactSemverSpecifier(specifier)).toBe(false);
    }
  );

  it('reports ranges and pinned-version drift independently', () => {
    expect(
      collectRuntimeDependencyVersionIssues({
        dependencyBlocks: [
          {
            'loro-crdt': '^1.15.1',
            '@lydell/node-pty': '1.2.0-beta.15',
          },
        ],
        exactDependencies: ['loro-crdt'],
        pinnedDependencies: new Map([['@lydell/node-pty', '1.2.0-beta.14']]),
      })
    ).toEqual([
      {
        dependencyName: 'loro-crdt',
        expectedVersion: 'an exact semantic version',
        actualVersion: '^1.15.1',
      },
      {
        dependencyName: '@lydell/node-pty',
        expectedVersion: '1.2.0-beta.14',
        actualVersion: '1.2.0-beta.15',
      },
    ]);
  });
});
