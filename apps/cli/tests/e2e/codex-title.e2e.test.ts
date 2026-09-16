import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/utils/logger';

import { generateTitleIsolated, sanitizeTitle } from '../../src/agent/title-generator';

const createSilentLogger = (): Logger => ({
  info: () => { },
  warn: () => { },
  error: () => { },
  success: () => { },
  debug: () => { },
  trace: () => { },
  setLevel: () => { },
  child: () => createSilentLogger(),
  close: async () => { },
});


const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

e2eDescribe('codex title e2e', () => {
  it(
    'generates a concise title with lightweight model',
    async () => {
      const logger = createSilentLogger();
      const taskPrompt =
        'Fix crash when opening FooBar with empty input; add guard and regression test.';

      const title = await generateTitleIsolated({
        cliType: 'builtin',
        agentType: 'codex',
        taskPrompt,
        logger,
      });

      expect(title).toBeTruthy();
      const sanitized = sanitizeTitle(title!);
      expect(sanitized).toBeTruthy();
      expect(sanitized!.length).toBeLessThanOrEqual(80);
      expect(sanitized).not.toContain('\n');
    },
    60000
  );
});
