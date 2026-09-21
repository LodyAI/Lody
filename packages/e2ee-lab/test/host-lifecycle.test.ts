import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanupLab, labClient, launchLab, tempDir } from '../src/fixtures';
import { startLabBackend } from '../src/backend';
import { CONTROL_STREAM, LORO_STREAM, MAX_LEASE_MS } from '../src/platform/protocol';
import { exportDevice, generateDevice } from '../src/platform/device';
import { fromHex, toHex } from '../src/platform/bytes';
import { maliciousAppendCas } from '../src/attacks';
import { LoroDoc } from 'loro-crdt';
import { InMemoryRemoteCursorStore } from '@loro-dev/streams-crdt/loro';
import {
  bootstrapLoroFromSnapshot,
  readLoro,
  syncLoroWithCursor,
  uploadLoroSnapshot,
  writeLoro,
} from '../src/platform/content-session';

afterEach(() => cleanupLab());

const STREAMS_SHA256 = 'a1314d8fbfaed381505001342d563993ae1f32c0682d9db8252c6f6eb97a391e';
const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

describe('lab host lifecycle', () => {
  it('vendors the continuationOffset streams-crdt tarball', () => {
    const tarball = join(here, '../vendor/streams-crdt.tgz');
    const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(actual).toBe(STREAMS_SHA256);
  });

  it('listens on loopback and creates a riverrun sqlite file', async () => {
    const host = await launchLab();
    expect(host.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    expect((await fetch(`${host.baseUrl}/healthz`)).status).toBe(200);
    const ready = await fetch(`${host.baseUrl}/readyz`);
    const body = (await ready.json()) as {
      ok?: boolean;
      riverrun?: string;
      riverrunDbPath?: string;
    };
    expect(ready.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.riverrun).toBeUndefined();
    expect(body.riverrunDbPath).toBeUndefined();
    expect(existsSync(host.riverrunDbPath)).toBe(true);
  });

  it('rejects unjoined POST/DELETE on the control stream', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const outsider = await labClient({ host, account: 'outsider' });
    const { genesisHex } = await alice.createSpace();
    const path = `/ds/${genesisHex}/${CONTROL_STREAM}`;
    const before = await alice.fetch(path, { method: 'HEAD' });
    const injected = await outsider.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 0, 0, 1, 255]),
    });
    const deleted = await outsider.fetch(path, { method: 'DELETE' });
    const after = await alice.fetch(path, { method: 'HEAD' });
    expect(injected.status === 401 || injected.status === 403).toBe(true);
    expect(deleted.status === 401 || deleted.status === 403).toBe(true);
    expect(before.headers.get('stream-next-offset')).toBe(after.headers.get('stream-next-offset'));
    expect((await alice.readLedger()).length).toBe(1);
  });

  it('recovers Loro text after a crash between document persist and cursor save', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'durable-after-cursor-crash');
    const memory = new InMemoryRemoteCursorStore();
    let failCursor = true;
    let snapshot: Uint8Array | undefined;
    const store = {
      load: (streamUrl: string) => memory.load(streamUrl),
      save: async (cursor: Parameters<InMemoryRemoteCursorStore['save']>[0]) => {
        if (failCursor) throw new Error('cursor-crash');
        await memory.save(cursor);
      },
    };
    await expect(
      syncLoroWithCursor(alice, store, async (doc) => {
        snapshot = doc.export({ mode: 'snapshot' });
      })
    ).rejects.toThrow('cursor-crash');
    expect(snapshot).toBeDefined();
    const restored = new LoroDoc();
    restored.import(snapshot!);
    expect(restored.getText('text').toString()).toContain('durable-after-cursor-crash');
    restored.free();
    failCursor = false;
    let recovered: Uint8Array | undefined;
    const first = await syncLoroWithCursor(alice, store, async (doc) => {
      recovered = doc.export({ mode: 'snapshot' });
    });
    expect(first).toContain('durable-after-cursor-crash');
    const second = await syncLoroWithCursor(alice, store, undefined, recovered);
    expect(second).toBe(first);
  });

  it('rotates the epoch, recovers history, and keeps historical reads after revoke', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'epoch-zero');
    const tablet = await generateDevice();
    expect((await alice.admitDevice(tablet, 'personal', false)).status).toBe('committed');
    await alice.deliverEpochKey(tablet, 0);
    const writer = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(tablet),
    });
    await writer.adoptGenesis(alice.genesisHex!);
    await writer.readLedger();
    const frames = await writer.readKeyFrames();
    await writer.receiveEpochKey(alice.device, 0, frames[0]!);
    expect(await readLoro(writer)).toContain('epoch-zero');
    expect((await alice.publishEpoch()).status).toBe('committed');
    const history = await alice.recoverEpochHistory();
    expect(history.size).toBe(2);
    expect(history.has(0)).toBe(true);
    expect(history.has(1)).toBe(true);
    expect((await alice.revokeDevice(tablet.publicKey)).status).toBe('committed');
    expect(await readLoro(alice)).toContain('epoch-zero');
    expect(writer.loroDoc?.getText('text').toString()).toContain('epoch-zero');
    await expect(readLoro(writer)).rejects.toThrow(/unauthorized|403|loro-sync-failed/);
    await expect(writeLoro(writer, 'after-revoke')).rejects.toThrow();
    await writeLoro(alice, 'epoch-one');
    expect(await readLoro(alice)).toContain('epoch-zero');
    expect(await readLoro(alice)).toContain('epoch-one');
  });

  it('rejects a member promoting itself to admin', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const joinReq = await bob.requestJoin(alice.genesisHex!);
    const admitted = await alice.approveJoin(joinReq);
    expect(admitted.status).toBe('committed');
    await expect(
      bob.submit({ type: 'setRole', membershipId: admitted.membershipId, role: 'admin' })
    ).rejects.toThrow();
    const member = (await alice.readLedger()).state.members.get(toHex(admitted.membershipId));
    expect(member?.role).toBe('member');
  });

  it('rejects a join request with a flipped signature', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const joinReq = await bob.requestJoin(alice.genesisHex!);
    const signature = fromHex(joinReq.signature);
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    const rejected = await alice.approveJoin({ ...joinReq, signature: toHex(signature) });
    expect(rejected.admitted).toBe(false);
    expect(rejected.roleConfigured).toBe(false);
    expect(rejected.status).not.toBe('committed');
    expect((await alice.readLedger()).state.members.size).toBe(1);
  });

  it('rejects content writes from a guest', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const joinReq = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(joinReq, 'guest')).status).toBe('committed');
    await bob.readLedger();
    expect(bob.canWriteDocument).toBe(false);
    await expect(writeLoro(bob, 'guest-write')).rejects.toThrow();
  });

  it('does not import another Org Loro ciphertext as local plaintext', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'org-a-secret');
    await bob.createSpace();
    await bob.readLedger();
    await writeLoro(bob, 'org-b-ok');
    const loro = await alice.fetch(`/ds/${alice.genesisHex}/${LORO_STREAM}`);
    const loroBytes = new Uint8Array(await loro.arrayBuffer());
    await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: bob.genesisHex!,
      record: loroBytes,
      expectedOffset: '-1',
      stream: LORO_STREAM,
    });
    let text = '';
    try {
      text = await readLoro(bob);
    } catch {
      text = '';
    }
    expect(text).not.toContain('org-a-secret');
  });

  it('bootstraps an admitted snapshot after the author is revoked', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    const tablet = await generateDevice();
    expect((await alice.admitDevice(tablet, 'personal', false)).status).toBe('committed');
    await alice.deliverEpochKey(tablet, 0);
    const writer = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(tablet),
    });
    await writer.adoptGenesis(alice.genesisHex!);
    await writer.readLedger();
    const frames = await writer.readKeyFrames();
    await writer.receiveEpochKey(alice.device, 0, frames[0]!);
    await uploadLoroSnapshot(writer, 'snap-from-tablet');
    expect((await bootstrapLoroFromSnapshot(alice, 'snap-from-tablet')).text).toContain(
      'snap-from-tablet'
    );
    expect((await alice.revokeDevice(tablet.publicKey)).status).toBe('committed');
    expect((await bootstrapLoroFromSnapshot(alice, 'snap-from-tablet')).text).toContain(
      'snap-from-tablet'
    );
  });

  it('rejects a delayed content write after the device is revoked', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    const tablet = await generateDevice();
    expect((await alice.admitDevice(tablet, 'personal', false)).status).toBe('committed');
    await alice.deliverEpochKey(tablet, 0);
    const writer = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(tablet),
    });
    await writer.adoptGenesis(alice.genesisHex!);
    await writer.readLedger();
    const frames = await writer.readKeyFrames();
    await writer.receiveEpochKey(alice.device, 0, frames[0]!);
    await writeLoro(writer, 'before-revoke');
    expect((await alice.revokeDevice(tablet.publicKey)).status).toBe('committed');
    await expect(writeLoro(writer, 'after-revoke')).rejects.toThrow();
  });

  it('rejects control writes after the original 15-minute lease', async () => {
    let now = 1_700_000_000_000;
    const host = await launchLab();
    host.setNow(now);
    const alice = await labClient({ host, account: 'alice', now: () => now });
    await alice.createSpace();
    expect((await alice.readLedger()).length).toBe(1);
    now += MAX_LEASE_MS;
    host.setNow(now);
    await expect(alice.readLedger()).rejects.toThrow();
  });

  it('restarts on the same data directory', async () => {
    const dir = tempDir('e2ee-lab-restart-');
    const first = await startLabBackend({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    expect((await fetch(`${first.baseUrl}/healthz`)).status).toBe(200);
    await first.close();
    const second = await startLabBackend({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    expect((await fetch(`${second.baseUrl}/healthz`)).status).toBe(200);
    await second.close();
  });

  it('cli process writes pid and shuts down on SIGTERM', async () => {
    const dir = tempDir('e2ee-lab-cli-');
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(here, '../src/cli.ts'), '--data-dir', dir, '--port', '0'],
      { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (chunk) => {
        text += String(chunk);
        if (text.includes('listening')) resolve(text);
      });
      child.on('error', reject);
      child.stderr?.on('data', (chunk) => {
        text += String(chunk);
      });
    });
    expect(output).toContain('http://127.0.0.1:');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(pid).toBe(child.pid);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  });

  for (const crashAt of [
    'after-import',
    'after-document',
    'before-cursor',
    'after-cursor',
  ] as const) {
    it(`recovers document and cursor after client SIGKILL at ${crashAt}`, async () => {
      const dataDir = tempDir(`e2ee-lab-crash-${crashAt}-host-`);
      const clientDir = tempDir(`e2ee-lab-crash-${crashAt}-alice-`);
      const marker = join(tempDir(`e2ee-lab-crash-${crashAt}-mark-`), 'marker');
      const text = `crash-${crashAt}`;
      const crash = spawn(
        process.execPath,
        ['--import', tsxLoader, join(here, 'crash-loro-client.ts')],
        {
          cwd: join(here, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            LAB_DATA_DIR: dataDir,
            LAB_CLIENT_DIR: clientDir,
            LAB_MARKER: marker,
            LAB_TEXT: text,
            LAB_CRASH_AT: crashAt,
          },
        }
      );
      let crashErr = '';
      crash.stderr?.on('data', (chunk) => {
        crashErr += String(chunk);
      });
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        crash.on('exit', (code, signal) => resolve({ code, signal }))
      );
      expect(exit.signal, crashErr).toBe('SIGKILL');
      expect(readFileSync(marker, 'utf8')).toBe(crashAt);
      const identity = JSON.parse(readFileSync(join(clientDir, 'crash-identity.json'), 'utf8')) as {
        genesisHex: string;
        device: string;
      };
      const restartMarker = `${marker}.restart`;
      const restart = spawn(
        process.execPath,
        ['--import', tsxLoader, join(here, 'crash-loro-client.ts')],
        {
          cwd: join(here, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            LAB_DATA_DIR: dataDir,
            LAB_CLIENT_DIR: clientDir,
            LAB_MARKER: restartMarker,
            LAB_TEXT: text,
            LAB_GENESIS: identity.genesisHex,
            LAB_DEVICE: identity.device,
          },
        }
      );
      let restartErr = '';
      restart.stderr?.on('data', (chunk) => {
        restartErr += String(chunk);
      });
      const restartExit = await new Promise<number | null>((resolve) =>
        restart.on('exit', (code) => resolve(code))
      );
      expect(restartExit, restartErr).toBe(0);
      const recovered = JSON.parse(readFileSync(restartMarker, 'utf8')) as { text: string };
      expect(recovered.text).toContain(text);
      // after-import crashes before persisting the imported ':tail' record; the
      // saved cursor must not skip it on restart.
      if (crashAt === 'after-import') expect(recovered.text).toContain(':tail');
    }, 90_000);
  }

  it('recovers ledger head after kill-after-commit', async () => {
    const dir = tempDir('e2ee-lab-kill-');
    const first = await spawnLab(dir);
    const { HonestClient } = await import('../src/actors');
    const alice = new HonestClient({
      baseUrl: first.baseUrl,
      clientDir: tempDir('e2ee-lab-kill-alice-'),
      account: 'alice',
      testMode: true,
    });
    await alice.start();
    await alice.createSpace();
    const token = readFileSync(join(dir, 'harness.token'), 'utf8').trim();
    await fetch(`${first.baseUrl}/v1/harness/failpoints`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'kill-after-commit' }),
    });
    await alice.admitDevice(await generateDevice(), 'personal', false).catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (first.child.exitCode !== null) resolve();
      else first.child.on('exit', () => resolve());
    });
    const second = await spawnLab(dir);
    const alice2 = new HonestClient({
      baseUrl: second.baseUrl,
      clientDir: alice.clientDir,
      account: 'alice',
      testMode: true,
      device: alice.device,
    });
    await alice2.start();
    await alice2.adoptGenesis(alice.genesisHex!);
    expect((await alice2.readLedger()).length).toBe(2);
    second.child.kill('SIGTERM');
    await new Promise<void>((resolve) => second.child.on('exit', () => resolve()));
  });
});

async function spawnLab(
  dataDir: string
): Promise<{ baseUrl: string; child: ReturnType<typeof spawn> }> {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, join(here, '../src/cli.ts'), '--data-dir', dataDir, '--test'],
    { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const output = await new Promise<string>((resolve, reject) => {
    let text = '';
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('listening')) resolve(text);
    });
    child.on('error', reject);
    child.stderr?.on('data', (chunk) => {
      text += String(chunk);
    });
    child.on('exit', (code) => {
      if (!text.includes('listening')) reject(new Error(`cli-exit-${code}:${text}`));
    });
  });
  const match = output.match(/e2ee-lab listening (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match?.[1]) throw new Error(`cli-url-missing:${output}`);
  return { baseUrl: match[1], child };
}
