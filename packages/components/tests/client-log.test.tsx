/** @vitest-environment jsdom */

import 'fake-indexeddb/auto';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLIENT_LOG_LIMITS,
  buildClientLogUploadWithin,
  installClientLog,
  type ClientLogLockManager,
  readClientLog,
  recordClientError,
  recordClientLog,
  redactClientLogText,
  resetClientLogForTests,
  simulateClientLogReloadForTests,
} from '../src/lib/client-log';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const START = Date.UTC(2026, 9, 16, 12);
let clockMs = START;
const clock = () => clockMs;
const uninstalls: Array<() => void> = [];

beforeEach(async () => {
  clockMs = START;
  await resetClientLogForTests(clock);
});

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  setLocks(undefined);
});

const install = () => uninstalls.push(installClientLog());
/** The page dies: listeners go away with it, nothing else runs. */
const killPage = async () => {
  uninstalls.splice(0).forEach((uninstall) => uninstall());
  await simulateClientLogReloadForTests(clock);
};
const setLocks = (locks: ClientLogLockManager | undefined) => {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
};
/** Web Locks as seen from a new page: these page locks are held by live pages. */
const locksHeldBy = (bootIds: () => string[]): ClientLogLockManager => ({
  request: () => new Promise(() => {}),
  query: async () => ({
    held: bootIds().map((id) => ({ name: `lody-client-log-page:${id}` })),
  }),
});
const bootIdsIn = (log: string) =>
  [...log.matchAll(/^\S+ \S+\s+([0-9a-f]{8}) page\.boot/gmu)].map((match) => match[1] ?? '');

describe('client log', () => {
  it('keeps the entries a reload would drop: they are saved on page hide', async () => {
    install();
    recordClientLog('warn', 'app.reload_requested');
    // A reload tears the page down before IndexedDB commits anything.
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    await killPage();
    install();

    const log = await readClientLog();
    expect(log).toContain('app.reload_requested');
    expect(log.match(/app\.reload_requested/gu)).toHaveLength(1);
  });

  it('drops entries older than 48 hours', async () => {
    recordClientLog('error', 'old.crash');
    clockMs += CLIENT_LOG_LIMITS.maxAgeMs + 1;
    recordClientLog('error', 'new.crash');

    const log = await readClientLog();
    expect(log).not.toContain('old.crash');
    expect(log).toContain('new.crash');
  });

  it('keeps the newest entries within the byte budget', async () => {
    const filler = 'x'.repeat(10 * 1024);
    const count = Math.ceil(CLIENT_LOG_LIMITS.maxBytes / filler.length) + 20;
    for (let index = 0; index < count; index += 1) {
      recordClientLog('info', `entry.${index}`, filler);
    }

    const log = await readClientLog();
    expect(new TextEncoder().encode(log).byteLength).toBeLessThanOrEqual(
      CLIENT_LOG_LIMITS.maxBytes
    );
    expect(log).toContain(`entry.${count - 1} `);
    expect(log).not.toContain('entry.0 ');
  });

  it('redacts credentials from messages, details and stacks', async () => {
    expect(redactClientLogText('GET /api?token=abc123&x=1 Bearer sk-secret-value')).toBe(
      'GET /api?token=[redacted]&x=1 Bearer [redacted]'
    );
    for (const leak of [
      'https://x/?refresh_token=leak1',
      'https://x/?api_key=leak2&ok=1',
      'https://x/?client_secret=leak3',
      'https://x/?id_token=leak4',
      'https://bucket/o?X-Amz-Credential=leak5&X-Amz-Signature=leak6',
      '{"token":"leak7","name":"ok"}',
      'Authorization: Basic leak8leak8',
      'x-api-key: leak9',
      'cookie=session_id%3Dleak10',
    ]) {
      expect(redactClientLogText(leak)).not.toMatch(/leak/u);
    }
    expect(redactClientLogText('exit code 1 while reading key events')).toBe(
      'exit code 1 while reading key events'
    );
    recordClientError('fetch.failed', new Error('401 for https://h/x?access_token=leak'), {
      url: 'https://h/y?ott=leak2',
    });

    const log = await readClientLog();
    expect(log).not.toContain('leak');
    expect(log).toContain('access_token=[redacted]');
  });

  it('keeps report logs available from memory when IndexedDB never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realIndexedDb = globalThis.indexedDB;
    // WebKit can leave an open pending forever after its storage process restarts.
    const hangingIndexedDb = { open: () => ({}) } as unknown as IDBFactory;
    Object.defineProperty(globalThis, 'indexedDB', { value: hangingIndexedDb, configurable: true });
    try {
      await simulateClientLogReloadForTests(clock);
      recordClientLog('error', 'crash.before.report');
      const upload = buildClientLogUploadWithin(5000);
      // The open gives up after 3 s; the entry is then sent from memory.
      await vi.advanceTimersByTimeAsync(3000);

      const result = await upload;
      expect(result).not.toBeNull();
      expect(gunzipSync(Buffer.from(result?.data ?? '', 'base64')).toString('utf8')).toContain(
        'crash.before.report'
      );
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: realIndexedDb, configurable: true });
      vi.useRealTimers();
    }
  });
});
