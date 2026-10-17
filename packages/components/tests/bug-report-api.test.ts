import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  attachClientDiagnostics,
  CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS,
} from '../src/lib/bug-report-api';
import { installCloudHttpPort } from '../src/lib/cloud-http-port';

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

it('never starts an already-cancelled upload', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  controller.abort();
  expect(await attachClientDiagnostics({ ...report, signal: controller.signal })).toEqual({
    ok: false,
    error: 'Client diagnostics upload cancelled.',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('cleans up cancellation and deadline after a successful attachment', async () => {
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signal = init.signal;
    return Promise.resolve(Response.json({ attached: true }));
  });
  const controller = new AbortController();
  expect(await attachClientDiagnostics({ ...report, signal: controller.signal })).toEqual({
    ok: true,
  });
  controller.abort();
  await vi.advanceTimersByTimeAsync(CLIENT_DIAGNOSTICS_UPLOAD_TIMEOUT_MS);
  expect(signal?.aborted).toBe(false);
});
