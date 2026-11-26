import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  extractPrivateFailureDetails,
  formatPublicStatusLine,
  readLogTail,
  readNativeStartupLogTail,
} from './selfhost-e2e-report.mjs';

await test('public status line exposes only suite statuses and never private paths or reasons', () => {
  const report = {
    status: 'failed',
    suites: {
      cloud: {
        status: 'failed',
        reason: '/private/loro-dev/lody/convex/internalSecret.ts exploded',
        journeys: [{ id: 'TURN-001', name: 'Send turn', status: 'failed' }],
      },
      e2e: { status: 'passed', shards: [] },
    },
  };
  const publicLine = formatPublicStatusLine(report, 1);
  assert.equal(
    publicLine,
    '[selfhost-e2e] status=failed exitCode=1 suites=cloud:failed,e2e:passed'
  );
  assert.doesNotMatch(publicLine, /convex|internalSecret|loro-dev/u);
});

await test('private failure details retain journey and shard breakdown for internal Feishu alerts', () => {
  const details = extractPrivateFailureDetails({
    status: 'failed',
    suites: {
      cloud: {
        status: 'failed',
        journeys: [{ id: 'TURN-001', name: 'Send turn', status: 'failed' }],
      },
      e2e: {
        status: 'failed',
        shards: [{ id: 'recovery', status: 'failed' }],
      },
    },
  });
  const text = details.join('\n');
  assert.match(text, /TURN-001/u);
  assert.match(text, /recovery/u);
});

await test('readLogTail extracts ANSI-stripped trailing lines for private Feishu failure cards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfhost-report-'));
  try {
    const logPath = join(dir, 'selfhost.log');
    writeFileSync(
      logPath,
      ['line 1', '\u001B[31mError: spawn mkcert ENOENT\u001B[0m', '', 'stack line 3'].join('\n'),
      'utf8'
    );
    const tail = readLogTail(logPath, { maxLines: 2, maxChars: 200 });
    assert.equal(tail, 'Error: spawn mkcert ENOENT\nstack line 3');

    const harnessLog = join(dir, 'harness.log');
    writeFileSync(harnessLog, 'attachment-worker exit code=1\n', 'utf8');
    const startupTail = readNativeStartupLogTail(
      `[local-stack] Native startup failed; see ${harnessLog}`
    );
    assert.equal(startupTail, 'attachment-worker exit code=1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
