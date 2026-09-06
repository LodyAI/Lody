import { describe, expect, it } from 'vitest';

import { getFirstTaskPrimaryAction } from '../src/components/onboarding/first-task-primary-action';

describe('getFirstTaskPrimaryAction', () => {
  it('runs the first task when every Session prerequisite is ready', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: true,
        startRequested: false,
      })
    ).toEqual({ kind: 'run', disabled: false, loading: false });
  });

  it('enters Lody instead of disabling an unavailable first task', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: false,
        hasPrompt: true,
        startRequested: false,
      })
    ).toEqual({ kind: 'enter', disabled: false, loading: false });
  });

  it('offers entry after background Session creation was requested', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: true,
        startRequested: true,
      })
    ).toEqual({ kind: 'enter', disabled: false, loading: false });
  });

  it('enters Lody instead of disabling the final action for an empty task', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: false,
        startRequested: false,
      })
    ).toEqual({ kind: 'enter', disabled: false, loading: false });
  });
});
