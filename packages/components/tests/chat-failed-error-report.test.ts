import { getChatFailedDiagnosticCopy } from '../src/components/ai-gui/chat-failed-diagnostic-copy';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  buildChatFailedNoticeDetail,
  extractReadableChatFailedMessage,
} from '../src/components/ai-gui/chat-failed-error-report';
import {
  attachClientDiagnostics,
  CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS,
} from '../src/lib/bug-report-api';
import { installCloudHttpPort } from '../src/lib/cloud-http-port';
import { appendClientBuildInfo, collectClientBuildInfo } from '../src/lib/client-build-info';
import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
} from '../src/lib/error-boundary-report';

describe('chat-failed-error-report', () => {
  describe('extractReadableChatFailedMessage', () => {
    it('pulls the message out of a nested ACP error payload', () => {
      expect(
        extractReadableChatFailedMessage(
          'Internal error: API Error: 500 {"error":{"message":"Overloaded","type":"overloaded_error"}}'
        )
      ).toBe('Overloaded');
    });

    it('handles escaped quotes inside the message value', () => {
      expect(
        extractReadableChatFailedMessage(
          'API Error: 400 {"message":"Missing required parameter \\"messages\\""}'
        )
      ).toBe('Missing required parameter "messages"');
    });

    it('strips known prefixes when there is no JSON payload', () => {
      expect(extractReadableChatFailedMessage('Internal error: spawn git ENOENT')).toBe(
        'spawn git ENOENT'
      );
    });

    it('returns the original text when nothing can be extracted', () => {
      expect(extractReadableChatFailedMessage('agent exited with code 1')).toBe(
        'agent exited with code 1'
      );
    });
  });

  describe('buildChatFailedNoticeDetail', () => {
    it('shows a prefixed multiline failure and its embedded advice only once', () => {
      const action = 'Check your connection and retry.';
      const message = `Internal error: connection setup timed out\n\n${action}`;
      expect(buildChatFailedNoticeDetail({ title: 'Restore failed', action, message })).toBe(
        message
      );
    });

    it('keeps upstream JSON and diagnostic fields without adding an extracted summary', () => {
      const message =
        'Internal error: API Error: 500 {"error":{"message":"Overloaded"},"request_id":"synthetic-id"}';
      expect(buildChatFailedNoticeDetail({ title: 'Overloaded', message })).toBe(message);
    });

    it('adds distinct localized advice while preserving raw whitespace and stack details', () => {
      const message = '  Internal error: spawn git ENOENT\n    at start (agent.ts:1)\n';
      const action = '请安装 Git 后重试。';
      expect(buildChatFailedNoticeDetail({ title: '启动失败', action, message })).toBe(
        `${action}\n\n${message}`
      );
    });

    it('omits empty detail and exact title repeats while keeping distinct advice', () => {
      expect(buildChatFailedNoticeDetail({ title: 'Failed', message: '  ' })).toBeUndefined();
      expect(
        buildChatFailedNoticeDetail({ title: 'Failed', message: ' Failed ', action: 'Failed' })
      ).toBeUndefined();
      expect(
        buildChatFailedNoticeDetail({ title: 'Failed', message: 'Failed', action: 'Retry.' })
      ).toBe('Retry.');
    });
  });

  describe('DeepSeek Node failure presentation', () => {
    it.each([
      ['DSH_NODE_NOT_FOUND', 'needs Node.js on the target machine'],
      ['DSH_NODE_UNSUPPORTED', 'needs a supported standalone Node.js version'],
      ['DSH_NODE_EXEC_FAILED', 'could not run Node.js on the target machine'],
    ])(
      'presents an actionable diagnostic for %s through the startup failure message',
      (code, title) => {
        const message = `Starting the agent failed: [${code}] synthetic runtime failure`;
        const diagnostic = getChatFailedDiagnosticCopy(undefined, message);
        expect(diagnostic?.title).toContain(title);
        if (!diagnostic) throw new Error('Expected a Node diagnostic');
        const detail = buildChatFailedNoticeDetail({
          title: diagnostic.title,
          action: diagnostic.action,
          message,
        });
        expect(detail).toContain('machine running this Agent');
        expect(detail).toContain('https://nodejs.org/en/download');
        expect(detail).toContain(message);
      }
    );

    it('keeps unrelated failures and Git diagnostics unchanged', () => {
      expect(getChatFailedDiagnosticCopy(undefined, 'ACP connection closed')).toBeNull();
      expect(getChatFailedDiagnosticCopy('git_executable_not_found')?.title).toContain(
        'Git executable'
      );
    });
  });
});

describe('bug-report-api', () => {
  const report = {
    workspaceId: 'workspace',
    bugReportId: 'report',
    diagnostics: 'client diagnostics',
    sessionToken: 'session',
  };
  let removePort: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    removePort = installCloudHttpPort({ authBaseUrl: 'https://auth.test', serverBaseUrl: null });
  });
  afterEach(() => {
    removePort();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['headers', 'body'])('bounds a stalled %s read and aborts the request', async (stall) => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      signal = init.signal;
      return stall === 'headers'
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(new ReadableStream()));
    });
    const pending = attachClientDiagnostics(report);
    await vi.advanceTimersByTimeAsync(CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: 'Client diagnostics upload timed out.' });
    expect(signal?.aborted).toBe(true);
  });

  it('settles caller cancellation even when a fetch adapter ignores abort', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const pending = attachClientDiagnostics({ ...report, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'Client diagnostics upload cancelled.' });
    expect(signal?.aborted).toBe(true);
  });
});

describe('error-boundary-report', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('reporting client provenance', () => {
    it('carries the frozen desktop identity into crash and description-only reports', () => {
      vi.stubGlobal('__APP_VERSION__', '1.2.3-nightly.42');
      vi.stubGlobal('__DESKTOP_RELEASE_CHANNEL__', 'nightly');
      vi.stubGlobal('__GIT_COMMIT__', 'a'.repeat(40));
      vi.stubGlobal('__OSS_GIT_COMMIT__', 'b'.repeat(40));
      vi.stubGlobal('__BUILD_DATE__', '2026-09-23T00:00:00.000Z');
      const environment = collectErrorBoundaryEnvironment();
      expect(collectClientBuildInfo()).toEqual({
        appVersion: '1.2.3-nightly.42',
        releaseChannel: 'nightly',
        build: 'a'.repeat(40),
        ossCommit: 'b'.repeat(40),
        buildDate: '2026-09-23T00:00:00.000Z',
      });
      const crash = buildErrorBoundaryReport({ error: 'render failed', environment });
      expect(crash.text).toContain('Release channel: nightly');
      expect(crash.text).toContain(`Build: ${'a'.repeat(40)}`);
      expect(crash.text).toContain(`Open-source commit: ${'b'.repeat(40)}`);
      // Even a caller passing a broader diagnostic object cannot add ambient data
      // to the normal bug report, or silently change the user's description.
      expect(
        appendClientBuildInfo('My exact description\n', {
          ...environment,
          url: 'https://example.test/private-path',
        } as typeof environment)
      ).toBe(
        [
          'My exact description\n',
          '',
          '---',
          'Reporting client build',
          'Version: 1.2.3-nightly.42',
          'Channel: nightly',
          `Build: ${'a'.repeat(40)}`,
          `Open-source commit: ${'b'.repeat(40)}`,
          'Build date: 2026-09-23T00:00:00.000Z',
        ].join('\n')
      );
    });

    it('keeps reports usable in compositions without injected build constants', () => {
      for (const key of [
        '__APP_VERSION__',
        '__DESKTOP_RELEASE_CHANNEL__',
        '__GIT_COMMIT__',
        '__OSS_GIT_COMMIT__',
        '__BUILD_DATE__',
      ]) {
        vi.stubGlobal(key, undefined);
      }
      expect(appendClientBuildInfo('original text')).toBe('original text');
      const report = buildErrorBoundaryReport({
        error: 'bare',
        environment: collectClientBuildInfo(),
      });
      expect(report.text).toBe('bare');
    });
  });
});
