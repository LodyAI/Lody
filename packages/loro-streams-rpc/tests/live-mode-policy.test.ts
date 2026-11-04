import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SSE_RETRY_COOLDOWN_MS,
  LoroStreamsLiveModePolicy,
  type LoroStreamsLiveModeDiagnostics,
} from '../src/index';

// Injected clock: the policy's only time dependency is the SSE re-probe
// cooldown, so tests move it explicitly instead of sleeping.
const createClock = (startMs = 1_000) => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

const healthySseRead = {
  requestedMode: 'auto',
  observedTransport: 'sse',
  deliveredBatch: true,
} as const;
const failedSseRead = {
  requestedMode: 'auto',
  observedTransport: 'sse',
  deliveredBatch: false,
  error: new Error('sse read failed'),
} as const;

describe('LoroStreamsLiveModePolicy', () => {
  it('requests SSE first, as auto so an unsupported server downgrades in-read', () => {
    const policy = new LoroStreamsLiveModePolicy({ now: createClock().now });

    expect(policy.selectRequestMode()).toBe('auto');
    expect(policy.getDiagnostics()).toMatchObject({ transport: 'sse', reason: 'initial' });
  });

  it('keeps SSE while reads stay healthy', () => {
    const policy = new LoroStreamsLiveModePolicy({ now: createClock().now });

    for (let index = 0; index < 10; index += 1) {
      expect(policy.selectRequestMode()).toBe('auto');
      policy.noteReadOutcome(healthySseRead);
    }

    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'sse',
      observedTransport: 'sse',
      transportSwitches: 0,
      consecutiveSseReadFailures: 0,
    });
  });

  it('falls back to long-poll after the configured number of consecutive failed SSE reads', () => {
    const clock = createClock();
    const changes: LoroStreamsLiveModeDiagnostics[] = [];
    const policy = new LoroStreamsLiveModePolicy({
      sseReadFailureLimit: 3,
      now: clock.now,
      onChange: (diagnostics) => changes.push(diagnostics),
    });

    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    expect(policy.getDiagnostics().transport).toBe('sse');
    expect(changes).toHaveLength(0);

    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);

    expect(policy.selectRequestMode()).toBe('long-poll');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-read-failures',
      transportSwitches: 1,
    });
  });

  it('treats an SSE read that delivered nothing as a failure', () => {
    const policy = new LoroStreamsLiveModePolicy({
      sseReadFailureLimit: 2,
      now: createClock().now,
    });

    // No error, but no data/up_to_date/eof either: the idle watchdog aborted a
    // silently stalled connection. A healthy read always delivers up_to_date.
    policy.selectRequestMode();
    policy.noteReadOutcome({
      requestedMode: 'auto',
      observedTransport: 'sse',
      deliveredBatch: false,
    });
    policy.selectRequestMode();
    policy.noteReadOutcome({
      requestedMode: 'auto',
      observedTransport: 'sse',
      deliveredBatch: false,
    });

    expect(policy.selectRequestMode()).toBe('long-poll');
    expect(policy.getDiagnostics().reason).toBe('sse-read-failures');
  });

  it('resets the failure streak when SSE recovers', () => {
    const policy = new LoroStreamsLiveModePolicy({
      sseReadFailureLimit: 3,
      now: createClock().now,
    });

    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    policy.selectRequestMode();
    policy.noteReadOutcome(healthySseRead);
    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);

    expect(policy.selectRequestMode()).toBe('auto');
    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'sse',
      consecutiveSseReadFailures: 1,
    });
  });

  it('pins long-poll permanently when the server reports SSE unsupported', () => {
    const clock = createClock();
    const policy = new LoroStreamsLiveModePolicy({ now: clock.now });

    // `auto` downgraded inside the read: the events came back as long-poll.
    expect(policy.selectRequestMode()).toBe('auto');
    policy.noteReadOutcome({
      requestedMode: 'auto',
      observedTransport: 'long-poll',
      deliveredBatch: true,
    });

    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-unsupported',
      nextSseProbeAtMs: undefined,
    });

    // Server capability, not a transient failure: never probe SSE again.
    clock.advance(DEFAULT_SSE_RETRY_COOLDOWN_MS * 100);
    expect(policy.selectRequestMode()).toBe('long-poll');
  });

  it('falls back when pending responses keep timing out on a healthy-looking SSE read', () => {
    const policy = new LoroStreamsLiveModePolicy({
      sseResponseTimeoutLimit: 3,
      now: createClock().now,
    });

    policy.selectRequestMode();
    policy.noteReadOutcome(healthySseRead);
    policy.noteResponseTimeout();
    policy.noteResponseTimeout();
    expect(policy.getDiagnostics().transport).toBe('sse');

    policy.noteResponseTimeout();

    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-response-starvation',
    });
  });

  it('does not count response timeouts once a response has been received', () => {
    const policy = new LoroStreamsLiveModePolicy({
      sseResponseTimeoutLimit: 2,
      now: createClock().now,
    });

    policy.noteResponseTimeout();
    policy.noteResponseReceived();
    policy.noteResponseTimeout();

    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'sse',
      sseResponseTimeouts: 1,
    });
  });

  it('recovers a pending write before RPC timeout and retains the SSE cooldown', () => {
    const clock = createClock();
    const policy = new LoroStreamsLiveModePolicy({ now: clock.now, sseRetryCooldownMs: 5_000 });
    policy.recoverPendingWrite();
    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'pending-write-recovery',
      sseResponseTimeouts: 0,
    });
    clock.advance(5_000);
    // A new interactive write renews long-poll instead of starting an SSE probe.
    policy.recoverPendingWrite();
    expect(policy.selectRequestMode()).toBe('long-poll');
    clock.advance(5_000);
    expect(policy.selectRequestMode()).toBe('auto');
  });

  it.each(['sse', 'long-poll'] as const)(
    'preserves the explicit %s pin during write recovery',
    (pin) => {
      const policy = new LoroStreamsLiveModePolicy({ pin });
      policy.recoverPendingWrite();
      expect(policy.selectRequestMode()).toBe(pin);
      expect(policy.getDiagnostics().transportSwitches).toBe(0);
    }
  );

  it('probes SSE again once the cooldown elapses, and re-falls back on a single failure', () => {
    const clock = createClock();
    const policy = new LoroStreamsLiveModePolicy({
      sseReadFailureLimit: 2,
      sseRetryCooldownMs: 60_000,
      now: clock.now,
    });

    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    expect(policy.selectRequestMode()).toBe('long-poll');

    clock.advance(59_999);
    expect(policy.selectRequestMode()).toBe('long-poll');

    clock.advance(1);
    expect(policy.selectRequestMode()).toBe('auto');
    expect(policy.getDiagnostics()).toMatchObject({ transport: 'sse', reason: 'sse-retry-probe' });

    // SSE already proved broken here, so a failed probe returns to long-poll
    // immediately instead of stranding calls for another full failure budget.
    policy.noteReadOutcome(failedSseRead);
    expect(policy.selectRequestMode()).toBe('long-poll');
    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'long-poll',
      reason: 'sse-read-failures',
      transportSwitches: 3,
    });
  });

  it('stays on SSE when a successful probe recovers the connection', () => {
    const clock = createClock();
    const policy = new LoroStreamsLiveModePolicy({
      sseReadFailureLimit: 1,
      sseRetryCooldownMs: 60_000,
      now: clock.now,
    });

    policy.selectRequestMode();
    policy.noteReadOutcome(failedSseRead);
    expect(policy.selectRequestMode()).toBe('long-poll');

    clock.advance(60_000);
    expect(policy.selectRequestMode()).toBe('auto');
    policy.noteReadOutcome(healthySseRead);

    expect(policy.selectRequestMode()).toBe('auto');
    expect(policy.getDiagnostics()).toMatchObject({
      transport: 'sse',
      consecutiveSseReadFailures: 0,
    });
  });

  it('never switches transports when pinned by configuration', () => {
    const onChange = vi.fn();
    const policy = new LoroStreamsLiveModePolicy({
      pin: 'long-poll',
      now: createClock().now,
      onChange,
    });

    expect(policy.selectRequestMode()).toBe('long-poll');
    policy.noteReadOutcome({
      requestedMode: 'long-poll',
      observedTransport: 'long-poll',
      deliveredBatch: false,
      error: new Error('poll failed'),
    });
    policy.noteResponseTimeout();

    expect(policy.selectRequestMode()).toBe('long-poll');
    expect(policy.getDiagnostics()).toMatchObject({ transport: 'long-poll', pinned: 'long-poll' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores long-poll read outcomes when scoring SSE health', () => {
    const policy = new LoroStreamsLiveModePolicy({ pin: 'sse', now: createClock().now });

    policy.noteReadOutcome({
      requestedMode: 'long-poll',
      observedTransport: 'long-poll',
      deliveredBatch: true,
    });

    expect(policy.getDiagnostics()).toMatchObject({ transport: 'sse', transportSwitches: 0 });
  });
});
