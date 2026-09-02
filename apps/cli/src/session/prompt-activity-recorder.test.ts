import { describe, expect, it } from 'vitest';

import { PromptActivityRecorder, allowsPromptReplay } from './prompt-activity-recorder';

describe('PromptActivityRecorder', () => {
  it('reports `none` for a prompt that did nothing', () => {
    expect(new PromptActivityRecorder().observe()).toBe('none');
    expect(allowsPromptReplay('none')).toBe(true);
  });

  it('reports persisted output once an update is routed', () => {
    const recorder = new PromptActivityRecorder();
    recorder.recordRouted();
    expect(recorder.observe()).toBe('persisted_output');
    expect(allowsPromptReplay('persisted_output')).toBe(false);
  });

  it('treats a permission request as activity even with no routed output', () => {
    // The whole point: `session/request_permission` is an independent JSON-RPC
    // request that never reaches `enqueueACPUpdate`, so this used to read as
    // "produced nothing" and authorized a replay of an already-approved tool.
    const recorder = new PromptActivityRecorder();
    recorder.recordSideEffect();
    expect(recorder.observe()).toBe('dropped_prompt_activity');
    expect(allowsPromptReplay('dropped_prompt_activity')).toBe(false);
  });

  it('treats a dropped update as activity', () => {
    const recorder = new PromptActivityRecorder();
    recorder.recordDropped('no_route');
    expect(recorder.observe()).toBe('dropped_prompt_activity');
  });

  it('never permits a replay for an unobservable turn', () => {
    expect(allowsPromptReplay('unknown')).toBe(false);
  });

  describe('steer handover attribution', () => {
    it('credits a side effect to the predecessor until the successor produces output', () => {
      // `steerApplicationBarrier` guards only `session/update`, so a permission
      // request or `fs/write_text_file` caused by the PREVIOUS turn can arrive
      // after the successor has bound. The predecessor is the run that may
      // already have acted, so it must not lose the signal.
      const predecessor = new PromptActivityRecorder();
      const successor = new PromptActivityRecorder(predecessor);

      successor.recordSideEffect();

      expect(predecessor.observe()).toBe('dropped_prompt_activity');
      expect(successor.observe()).toBe('dropped_prompt_activity');
    });

    it('stops crediting the predecessor once the successor has its own output', () => {
      const predecessor = new PromptActivityRecorder();
      const successor = new PromptActivityRecorder(predecessor);

      successor.recordRouted();
      successor.recordSideEffect();

      // The handover is complete, so this side effect belongs to the successor.
      expect(predecessor.observe()).toBe('none');
      expect(successor.observe()).toBe('persisted_output');
    });

    it('does not let a successor drop reach the predecessor', () => {
      // Only side effects are ambiguous across the handover. A dropped update is
      // routed through the bound recorder, so its attribution is already exact.
      const predecessor = new PromptActivityRecorder();
      const successor = new PromptActivityRecorder(predecessor);

      successor.recordDropped('no_route');

      expect(predecessor.observe()).toBe('none');
      expect(successor.observe()).toBe('dropped_prompt_activity');
    });
  });
});
