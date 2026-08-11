import { describe, expect, it } from 'vitest';

import {
  buildErrorBoundaryReport,
  describeErrorForReport,
  type ErrorBoundaryReportEnvironment,
} from '../src/lib/error-boundary-report';

const ENVIRONMENT: ErrorBoundaryReportEnvironment = {
  url: 'https://lody.ai/acme/chat',
  userAgent: 'Mozilla/5.0 (Test)',
  online: true,
  timestamp: '2026-08-09T10:00:00.000Z',
  runtime: 'electron',
  os: 'darwin',
  appVersion: '1.2.3',
  build: 'abc1234',
  buildDate: '2026-08-08T00:00:00.000Z',
  language: 'zh-CN',
};

function errorWithStack(message: string, stack: string): Error {
  const error = new Error(message);
  error.stack = stack;
  return error;
}

describe('describeErrorForReport', () => {
  it('prefixes the error name so the class of failure is visible at a glance', () => {
    expect(describeErrorForReport(new TypeError('x is not a function'))).toBe(
      'TypeError: x is not a function'
    );
  });

  it('falls back to the name when there is no message', () => {
    expect(describeErrorForReport(new RangeError(''))).toBe('RangeError');
  });

  it('describes non-Error throws instead of rendering [object Object]', () => {
    expect(describeErrorForReport('boom')).toBe('boom');
    expect(describeErrorForReport({ code: 'E_BAD' })).toBe('{"code":"E_BAD"}');
    expect(describeErrorForReport(undefined)).toBe('Unknown error');
  });
});

describe('buildErrorBoundaryReport', () => {
  it('carries the boundary, environment, stack, and component stack in the copy payload', () => {
    const report = buildErrorBoundaryReport({
      error: errorWithStack('render failed', 'Error: render failed\n    at Chat (chat.tsx:1:1)'),
      boundaryName: 'RootOutlet',
      componentStack: '\n    at Chat\n    at RootOutlet\n',
      environment: ENVIRONMENT,
    });

    expect(report.summary).toBe('Error: render failed');
    expect(report.text).toBe(
      [
        'Error: render failed',
        '',
        'Boundary: RootOutlet',
        'URL: https://lody.ai/acme/chat',
        'Runtime: electron',
        'OS: darwin',
        'App version: 1.2.3',
        'Build: abc1234',
        'Build date: 2026-08-08T00:00:00.000Z',
        'Language: zh-CN',
        'User agent: Mozilla/5.0 (Test)',
        'Online: yes',
        'Time: 2026-08-09T10:00:00.000Z',
        '',
        'Stack:',
        'Error: render failed',
        '    at Chat (chat.tsx:1:1)',
        '',
        'Component stack:',
        'at Chat',
        '    at RootOutlet',
      ].join('\n')
    );
  });

  it('records an offline crash as such — it changes what we look at first', () => {
    const report = buildErrorBoundaryReport({
      error: new Error('Failed to fetch dynamically imported module'),
      environment: { ...ENVIRONMENT, online: false },
    });

    expect(report.details).toContain('Online: no');
  });

  it('omits absent context instead of emitting empty or "undefined" lines', () => {
    const report = buildErrorBoundaryReport({
      error: errorWithStack('bare', 'Error: bare'),
      environment: { runtime: 'web' },
    });

    expect(report.details).toBe('Runtime: web\n\nStack:\nError: bare');
    expect(report.details).not.toContain('undefined');
    expect(report.details).not.toContain('Boundary');
  });

  it('still produces a copyable summary when there is nothing but the throw', () => {
    const report = buildErrorBoundaryReport({ error: 'boom', environment: {} });
    expect(report.text).toBe('boom');
  });
});
