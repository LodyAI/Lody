import { describe, expect, it } from 'vitest';

import { buildProviderWaitReport } from '../src/components/onboarding/provider-wait-report';

const base = {
  agentName: 'Claude Code',
  cliType: 'builtin' as const,
  agentType: 'claude',
  phase: 'probing-provider' as const,
  elapsedSeconds: 74,
  environment: {
    runtime: 'electron',
    os: 'darwin',
    appVersion: '0.90.0',
    build: 'abc1234',
    language: 'en-US',
    online: true,
    timestamp: '2026-09-06T09:00:00.000Z',
  },
};

describe('buildProviderWaitReport', () => {
  it('carries the three things the user cannot see: stage, elapsed, and build', () => {
    expect(buildProviderWaitReport(base)).toBe(
      [
        'Lody: agent setup is taking longer than usual',
        '',
        'Agent: Claude Code (builtin/claude)',
        'Stage: probing-provider',
        'Setup elapsed: 74s',
        'Runtime: electron',
        'OS: darwin',
        'App version: 0.90.0',
        'Build: abc1234',
        'Language: en-US',
        'Online: yes',
        'Time: 2026-09-06T09:00:00.000Z',
      ].join('\n')
    );
  });

  it('labels the counter as setup elapsed, not as time in the stage', () => {
    // The timer is request-scoped, so a download that just handed off to the
    // ACP handshake reports 74s of SETUP against a stage one second old. The
    // label is what keeps that from reading as a claim about the stage.
    const report = buildProviderWaitReport(base);
    expect(report).toContain('Setup elapsed: 74s');
    expect(report).not.toContain('Stage elapsed');
  });

  it('reports a download percentage only when one exists', () => {
    expect(
      buildProviderWaitReport({
        ...base,
        phase: 'downloading-runtime',
        percent: 63.6,
      })
    ).toContain('Download: 64%');
    expect(buildProviderWaitReport({ ...base, percent: null })).not.toContain('Download:');
    expect(buildProviderWaitReport({ ...base, percent: Number.NaN })).not.toContain('Download:');
  });

  it('drops environment fields the host could not supply', () => {
    const report = buildProviderWaitReport({ ...base, environment: { runtime: 'web' } });
    expect(report).toContain('Runtime: web');
    expect(report).not.toContain('OS:');
    expect(report).not.toContain('Online:');
  });

  it('is not localized, so a stage id stays greppable whatever the user reads', () => {
    // Whoever answers in the chat reads this, not the user. A translated stage
    // name is a stage name we cannot search for.
    expect(buildProviderWaitReport({ ...base, phase: 'extracting-runtime' })).toContain(
      'Stage: extracting-runtime'
    );
  });

  it('never reports a negative or fractional elapsed', () => {
    expect(buildProviderWaitReport({ ...base, elapsedSeconds: -5 })).toContain(
      'Setup elapsed: 0s'
    );
    expect(buildProviderWaitReport({ ...base, elapsedSeconds: 12.9 })).toContain(
      'Setup elapsed: 12s'
    );
  });
});
