import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSourceDaemonInstaller } from './check-installer.mjs';

async function fixture(run) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-install-gate-'));
  const marker = path.join(sourceRoot, 'packages/components/src/lib/daemon-installation.ts');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '// synthetic installer client');
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/api/install/')) {
      const platform = url.pathname.split('/').at(-1);
      const channel = url.pathname.split('/').at(-2);
      const distribution = channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon';
      return new Response(
        [
          'LODY-DAEMON-INSTALL-1',
          'lody-cloud',
          distribution,
          '1.2.3',
          channel,
          platform,
          'daemon.gz',
          'a'.repeat(64),
          '10',
          'b'.repeat(64),
          '20',
          '',
        ].join('\n')
      );
    }
    return new Response(null, {
      headers: { 'content-type': 'text/plain', 'content-length': '10' },
    });
  };
  try {
    await run(
      {
        sourceRoot,
        channel: 'stable',
        expectedVersion: '1.2.3',
        baseUrl: 'https://artifact.example.invalid',
        fetchImpl,
      },
      marker
    );
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

test('allows new clients only with both scripts and all six capsule/Node downloads', async () => {
  await fixture(async (options) =>
    assert.deepEqual(await checkSourceDaemonInstaller(options), {
      status: 'ready',
      channel: 'stable',
    })
  );
});
test('blocks a first rollout when one platform, script or Node archive is unavailable', async () => {
  for (const failed of ['/api/install/daemon/stable/win32-arm64', '/install.ps1', '/node.gz'])
    await fixture(async (options) => {
      const original = options.fetchImpl;
      options.fetchImpl = async (input) =>
        new URL(input).pathname.endsWith(failed)
          ? new Response(null, { status: 404 })
          : original(input);
      await assert.rejects(checkSourceDaemonInstaller(options), /not ready/);
    });
});
test('blocks stale channel pointers after a successful new binary publication', async () => {
  await fixture(async (options) =>
    assert.rejects(
      checkSourceDaemonInstaller({ ...options, expectedVersion: '1.2.4' }),
      /identity mismatch/
    )
  );
});
test('does not add a network dependency to recovery of old npx clients', async () => {
  await fixture(async (options, marker) => {
    fs.unlinkSync(marker);
    options.fetchImpl = async () => {
      throw new Error('legacy recovery must not fetch installer');
    };
    assert.deepEqual(await checkSourceDaemonInstaller(options), { status: 'legacy' });
  });
});

test('checks the independent Next and Nightly installation channels', async () => {
  for (const channel of ['next', 'nightly'])
    await fixture(async (options) =>
      assert.deepEqual(await checkSourceDaemonInstaller({ ...options, channel }), {
        status: 'ready',
        channel,
      })
    );
});
