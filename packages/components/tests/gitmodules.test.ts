import { describe, expect, it } from 'vitest';
import {
  parseGitHubRepoFromRemoteUrl,
  parseGitmodules,
  resolveSubmoduleRepo,
} from '@/lib/gitmodules';

describe('gitmodules', () => {
  it('reads path and url per submodule, skipping comments and incomplete entries', () => {
    const text = [
      '# vendored',
      '[submodule "proto"]',
      '\tpath = proto/',
      '\turl = git@github.com:acme/proto.git ; ssh',
      '[submodule "docs"]',
      '\tpath = docs',
      '[core]',
      '\turl = https://github.com/acme/ignored',
      '[submodule "lib\\"x"]',
      '  path = "third party/lib"',
      '  url = ../lib.git',
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([
      { name: 'proto', path: 'proto', url: 'git@github.com:acme/proto.git' },
      { name: 'lib"x', path: 'third party/lib', url: '../lib.git' },
    ]);
  });

  it('recognises every github.com remote form and nothing else', () => {
    for (const url of [
      'https://github.com/acme/proto.git',
      'https://token@github.com/acme/proto',
      'git@github.com:acme/proto.git',
      'ssh://git@github.com:22/acme/proto.git',
      'git://github.com/acme/proto',
    ]) {
      expect(parseGitHubRepoFromRemoteUrl(url)).toBe('acme/proto');
    }
    expect(parseGitHubRepoFromRemoteUrl('https://gitlab.com/acme/proto.git')).toBeUndefined();
    expect(parseGitHubRepoFromRemoteUrl('https://github.com/acme')).toBeUndefined();
  });

  it('resolves relative submodule URLs against the parent repository', () => {
    expect(resolveSubmoduleRepo('../proto.git', 'acme/api')).toBe('acme/proto');
    expect(resolveSubmoduleRepo('../../other/lib', 'acme/api')).toBe('other/lib');
    expect(resolveSubmoduleRepo('../proto.git', undefined)).toBeUndefined();
    expect(resolveSubmoduleRepo('../../../x', 'acme/api')).toBeUndefined();
  });
});
