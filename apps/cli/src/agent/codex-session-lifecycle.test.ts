import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setCodexThreadArchived } from './codex-session-lifecycle';
import { isPidAliveSyncLegacy } from '@lody/shared/node/process';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function nativeFixture(archived = false, failure?: 'identity' | 'archive' | 'store') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lody-codex-archive-'));
  directories.push(home);
  const active = path.join(home, 'sessions', 'rollout.jsonl');
  const archive = path.join(home, 'archived_sessions', 'rollout.jsonl');
  await mkdir(path.dirname(active));
  await mkdir(path.dirname(archive));
  await writeFile(archived ? archive : active, 'synthetic conversation\n');
  const fixture = path.join(home, 'server.cjs');
  await writeFile(
    fixture,
    `const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.env.CODEX_HOME;
const active = path.join(home, 'sessions', 'rollout.jsonl');
const archive = path.join(home, 'archived_sessions', 'rollout.jsonl');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  const answer = result => console.log(JSON.stringify({ id: request.id, result }));
  const fail = () => console.log(JSON.stringify({ id: request.id, error: { code: -32600 } }));
  if (request.method === 'initialize') { initialized = true; answer({}); return; }
  if (!initialized || request.params.threadId !== 'exact-native-id') { fail(); return; }
  if (request.method === 'thread/read') {
    answer({ thread: { id: ${JSON.stringify(failure === 'identity' ? 'different-id' : 'exact-native-id')}, path: ${failure === 'store' ? JSON.stringify('/different-account/sessions/rollout.jsonl') : 'fs.existsSync(archive) ? archive : active'} } });
  } else if (request.method === 'thread/archive') {
    if (${failure === 'archive'} || !fs.existsSync(active)) { fail(); return; }
    fs.renameSync(active, archive); answer({});
  } else if (request.method === 'thread/unarchive') {
    if (!fs.existsSync(archive)) { fail(); return; }
    fs.renameSync(archive, active); answer({});
  } else fail();
});
`
  );
  return {
    home,
    active,
    archive,
    options: {
      command: process.execPath,
      args: [fixture],
      env: { ...process.env, CODEX_HOME: home },
      threadId: 'exact-native-id',
    },
  };
}

describe('Codex native archive synchronization (#1537)', () => {
  it('archives and restores the exact native conversation in its own home', async () => {
    const fixture = await nativeFixture();
    await setCodexThreadArchived({ ...fixture.options, archived: true });
    expect(existsSync(fixture.active)).toBe(false);
    expect(await readFile(fixture.archive, 'utf8')).toBe('synthetic conversation\n');
    await setCodexThreadArchived({ ...fixture.options, archived: false });
    expect(existsSync(fixture.archive)).toBe(false);
    expect(await readFile(fixture.active, 'utf8')).toBe('synthetic conversation\n');
  });

  it('treats an already-archived thread as synchronized without issuing archive again', async () => {
    const fixture = await nativeFixture(true);
    await setCodexThreadArchived({ ...fixture.options, archived: true });
    expect(existsSync(fixture.active)).toBe(false);
    expect(await readFile(fixture.archive, 'utf8')).toBe('synthetic conversation\n');
  });

  it('leaves an active thread active when restore is observed twice', async () => {
    const fixture = await nativeFixture();
    await setCodexThreadArchived({ ...fixture.options, archived: false });
    expect(existsSync(fixture.archive)).toBe(false);
    expect(await readFile(fixture.active, 'utf8')).toBe('synthetic conversation\n');
  });

  it('refuses a different native identity rather than matching its title or workspace', async () => {
    const fixture = await nativeFixture(false, 'identity');
    await expect(setCodexThreadArchived({ ...fixture.options, archived: true })).rejects.toThrow(
      'identity'
    );
    expect(existsSync(fixture.archive)).toBe(false);
    expect(existsSync(fixture.active)).toBe(true);
  });

  it('reports a native failure without modifying or deleting the conversation', async () => {
    const fixture = await nativeFixture(false, 'archive');
    await expect(setCodexThreadArchived({ ...fixture.options, archived: true })).rejects.toThrow(
      'thread/archive'
    );
    expect(existsSync(fixture.archive)).toBe(false);
    expect(await readFile(fixture.active, 'utf8')).toBe('synthetic conversation\n');
  });

  it('refuses a native thread from another account store', async () => {
    const fixture = await nativeFixture(false, 'store');
    await expect(setCodexThreadArchived({ ...fixture.options, archived: true })).rejects.toThrow(
      'different session store'
    );
    expect(existsSync(fixture.active)).toBe(true);
    expect(existsSync(fixture.archive)).toBe(false);
  });

  it('cancels a pending metadata guard and releases the native process', async () => {
    const fixture = await nativeFixture();
    const controller = new AbortController();
    let pid: number | undefined;
    await expect(
      setCodexThreadArchived({
        ...fixture.options,
        archived: true,
        signal: controller.signal,
        onSpawned: (nativePid) => {
          pid = nativePid;
        },
        shouldApply: () => {
          controller.abort();
          return new Promise<boolean>(() => {});
        },
      })
    ).rejects.toThrow('cancelled');
    if (pid === undefined) throw new Error('Expected the native process to have spawned');
    expect(isPidAliveSyncLegacy(pid)).toBe(false);
    expect(existsSync(fixture.active)).toBe(true);
  });

  it('terminates its native process when cancellation arrives during spawn', async () => {
    const fixture = await nativeFixture();
    const controller = new AbortController();
    let pid: number | undefined;
    await expect(
      setCodexThreadArchived({
        ...fixture.options,
        archived: true,
        signal: controller.signal,
        onSpawned: (nativePid) => {
          pid = nativePid;
          controller.abort();
        },
      })
    ).rejects.toThrow();
    if (pid === undefined) throw new Error('Expected the native process to have spawned');
    expect(isPidAliveSyncLegacy(pid)).toBe(false);
    expect(existsSync(fixture.active)).toBe(true);
    expect(existsSync(fixture.archive)).toBe(false);
  });
});
