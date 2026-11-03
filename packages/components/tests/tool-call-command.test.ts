import { describe, expect, it } from 'vitest';

import { isToolCommandEcho } from '../src/components/ai-gui/tool-call-command';

describe('isToolCommandEcho', () => {
  it('matches a linked path echo without hiding a different command or result', () => {
    const command = 'grep READY /tmp/build-check.log | tail -5';
    const linked = 'grep READY [/tmp/build-check.log](file:///tmp/build-check.log) | tail -5';
    expect(isToolCommandEcho(linked, [command])).toBe(true);
    expect(isToolCommandEcho(`${linked}\nBuild failed`, [command])).toBe(false);
    expect(isToolCommandEcho(linked, ['grep FAILED /tmp/build-check.log | tail -5'])).toBe(false);
  });
});
