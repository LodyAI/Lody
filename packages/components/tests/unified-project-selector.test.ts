import { describe, expect, it } from 'vitest';

import { compareUnifiedProjectOptions } from '../src/components/chat/unified-project-selector';

describe('compareUnifiedProjectOptions', () => {
  it('mixes local and GitHub projects by recent activity', () => {
    const projects = [
      { value: 'local:machine:lody', label: 'lody', lastUsedAt: 200 },
      { value: 'github:loro-dev/loro', label: 'loro-dev/loro', lastUsedAt: 300 },
      { value: 'local:machine:mirror', label: 'mirror', lastUsedAt: 100 },
    ];

    expect(projects.sort(compareUnifiedProjectOptions).map((project) => project.value)).toEqual([
      'github:loro-dev/loro',
      'local:machine:lody',
      'local:machine:mirror',
    ]);
  });
});
