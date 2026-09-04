import { describe, expect, it } from 'vitest';

import { PromptActivityRecorder, allowsPromptReplay } from './prompt-activity-recorder';

describe('PromptActivityRecorder', () => {
  it('allows replay only when the observed prompt did nothing', () => {
    const recorder = new PromptActivityRecorder();
    expect(recorder.observe()).toBe('none');
    expect(allowsPromptReplay(recorder.observe())).toBe(true);

    recorder.recordSideEffect();
    expect(recorder.observe()).toBe('dropped_prompt_activity');
    expect(allowsPromptReplay(recorder.observe())).toBe(false);

    recorder.recordRouted();
    expect(recorder.observe()).toBe('persisted_output');
    expect(allowsPromptReplay('unknown')).toBe(false);
  });

  it('credits ambiguous side effects to the predecessor until successor output', () => {
    const predecessor = new PromptActivityRecorder();
    const successor = new PromptActivityRecorder(predecessor);
    successor.recordSideEffect();
    expect(predecessor.observe()).toBe('dropped_prompt_activity');

    const completedPredecessor = new PromptActivityRecorder();
    const producingSuccessor = new PromptActivityRecorder(completedPredecessor);
    producingSuccessor.recordRouted();
    producingSuccessor.recordSideEffect();
    expect(completedPredecessor.observe()).toBe('none');
    expect(producingSuccessor.observe()).toBe('persisted_output');
  });
});
