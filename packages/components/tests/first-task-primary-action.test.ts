import { describe, expect, it } from 'vitest';

import { getFirstTaskPrimaryAction } from '../src/components/onboarding/first-task-primary-action';

describe('getFirstTaskPrimaryAction', () => {
  it('runs the first task when every Session prerequisite is ready', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: true,
        submitting: false,
        startFailed: false,
      })
    ).toEqual({ kind: 'run', disabled: false, loading: false });
  });

  it('enters Lody instead of disabling an unavailable first task', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: false,
        hasPrompt: true,
        submitting: false,
        startFailed: false,
      })
    ).toEqual({ kind: 'enter', disabled: false, loading: false });
  });

  it('offers entry after a real Session start fails', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: true,
        submitting: false,
        startFailed: true,
      })
    ).toEqual({ kind: 'enter', disabled: false, loading: false });
  });

  it('keeps the run action stable and disabled while Session creation is in flight', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: true,
        submitting: true,
        startFailed: false,
      })
    ).toEqual({ kind: 'run', disabled: true, loading: true });
  });

  it('waits for task text when the environment itself can run', () => {
    expect(
      getFirstTaskPrimaryAction({
        canStartFirstTask: true,
        hasPrompt: false,
        submitting: false,
        startFailed: false,
      })
    ).toEqual({ kind: 'run', disabled: true, loading: false });
  });
});
