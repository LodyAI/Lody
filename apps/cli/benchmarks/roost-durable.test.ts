// Manual synthetic benchmark; excluded from default CI. See
// .agents/docs/roost-validation.md for the fixed workloads, setup and result limits.
import { it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import Database from 'better-sqlite3';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import { createSessionBackend } from '../src/session/session-backend';
import {
  getSessionRoomId,
  SessionStatusFactory,
  applyNotificationOnHistory,
  type SessionId,
  type SessionHistoryInput,
} from '@lody/shared';

const dir = process.env.LONG_BENCH_DIR;
assert.ok(
  dir && isAbsolute(dir),
  'Set LONG_BENCH_DIR to an absolute synthetic benchmark directory'
);
assert.ok(!process.env.LONG_BENCH_KIND || ['loro', 'roost'].includes(process.env.LONG_BENCH_KIND));
const kind = process.env.LONG_BENCH_KIND === 'loro' ? 'loro' : 'roost';
const rounds = Number(process.env.LONG_BENCH_ROUNDS ?? 100);
const chunks = Number(process.env.LONG_BENCH_CHUNKS ?? 20);
const chunkBytes = Number(process.env.LONG_BENCH_CHUNK_BYTES ?? 256);
const toolBytes = Number(process.env.LONG_BENCH_TOOL_BYTES ?? 16384);
const mixed = process.env.LONG_BENCH_MIXED === '1';
const stage = process.env.LONG_BENCH_STAGE ?? 'write';
const sampleSuffix = process.env.LONG_BENCH_SAMPLE_SUFFIX ?? '';
assert.ok(['write', 'reopen', 'paging'].includes(stage), 'Unknown benchmark stage');
assert.ok([rounds, chunks, chunkBytes, toolBytes].every((n) => Number.isSafeInteger(n) && n > 0));
const id = '00000000-0000-4000-8000-000000000002' as SessionId;
const room = getSessionRoomId(id);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)])
        )
      : value;
const text = (seed: string, bytes: number) => {
  let out = '';
  for (let i = 0; out.length < bytes; i++)
    out += createHash('sha256').update(`${seed}/${i}`).digest('base64url');
  return out.slice(0, bytes);
};
const updates = (round: number, index: number) => {
  const body = text(`chunk/${round}/${index}`, chunkBytes);
  const textValue = mixed
    ? `${index === 0 ? '\n<thinking>\n' : ''}${index === Math.floor(chunks / 3) ? '\n</thinking>\n' : ''}${body}${index % 17 === 0 ? '🙂' : ''}`
    : body;
  return [
    {
      sessionId: 'synthetic-acp',
      update: {
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text' as const, text: textValue },
      },
    },
    ...(mixed && index % 10 === 0
      ? [
          {
            sessionId: 'synthetic-acp',
            update: {
              sessionUpdate: 'tool_call_update' as const,
              toolCallId: `tool-${round}`,
              title: `Synthetic update ${index}`,
              status: 'completed' as const,
            },
          },
          {
            sessionId: 'synthetic-acp',
            update: {
              sessionUpdate: 'plan' as const,
              entries: [
                {
                  content: `step ${index}`,
                  priority: 'medium' as const,
                  status: 'pending' as const,
                },
              ],
            },
          },
        ]
      : []),
  ];
};
const assistantFixture = (round: number): SessionHistoryInput => ({
  id: `assistant-${round}`,
  role: 'assistant',
  timestamp: '2026-10-22T00:00:01.000Z',
  finished: false,
  items: [
    {
      type: 'tool_call',
      toolCallId: `tool-${round}`,
      status: 'completed',
      title: 'Synthetic output',
      rawOutput: { text: text(`tool/${round}`, toolBytes) },
    },
    { type: 'text', text: '' },
  ],
  fileDiff: [],
});
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    totalMs: samples.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
};
const timer = async <T>(fn: () => Promise<T> | T) => {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
};
const cpuMs = (cpu: NodeJS.CpuUsage) => (cpu.user + cpu.system) / 1000;

it('measures durable long-conversation writes and windowed reads', async () => {
  await mkdir(dir, { recursive: true });
  if (stage === 'write')
    assert.equal((await readdir(dir)).length, 0, 'Write stage needs an empty directory');
  const rssAtStart = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  let peakRss = rssAtStart;
  const trajectory: Array<{ phase: string } & NodeJS.MemoryUsage> = [];
  const memory = (phase?: string) => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    if (phase) trajectory.push({ phase, ...current });
    if (current.rss > 2 * 1024 ** 3)
      throw new Error('Isolated benchmark exceeded 2 GiB RSS budget');
    return current;
  };
  memory('process-start');
  // Both backends use WAL + FULL. Explicit per-action persistence avoids comparing
  // Roost durable acknowledgment against a merely in-memory Loro mutation.
  const control = new Database(join(dir, 'loro.db'));
  control.pragma('journal_mode = WAL');
  control.pragma('synchronous = FULL');
  const store = new SqliteRepoStore({ database: control, wal: false });
  if (kind === 'roost') installRoostNodeSessionBackend({ dbPath: join(dir, 'history.db') });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  if (stage === 'write')
    await repo.upsertDocMeta(room, {
      id,
      historyBackend: kind,
      userId: 'test-user',
      machineId: 'test-machine',
      status: SessionStatusFactory.idle(),
    });
  const doc = new SessionDocument(repo, id, (r) => repo.unloadDoc(r));
  const opened = await timer(async () => {
    doc.handle = await repo.openPersistedDoc(room);
    doc.composeSessionData(doc.handle.doc, undefined, { historyBackend: kind });
    return createSessionBackend(doc, { historyBackend: kind });
  });
  const backend = opened.value;
  memory('backend-open');
  const persist = async () => {
    assert.ok(doc.handle);
    await repo.persistDocNow(room, doc.handle.doc);
  };
  const dbSize = (file: string) => {
    // Never open the Rust-owned file through better-sqlite3 in the same process:
    // two SQLite copies cannot coordinate their POSIX descriptor/lock bookkeeping.
    return Number(
      execFileSync(
        'python3',
        [
          '-c',
          'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("pragma page_count").fetchone()[0]*c.execute("pragma page_size").fetchone()[0]); c.close()',
          file,
        ],
        { encoding: 'utf8' }
      )
    );
  };
  const fileBytes = (name: string) => {
    try {
      return statSync(join(dir, name)).size;
    } catch {
      return 0;
    }
  };
  const size = () => ({
    loroDbBytes: dbSize(join(dir, 'loro.db')),
    roostDbBytes: kind === 'roost' ? dbSize(join(dir, 'history.db')) : 0,
    loroWalBytes: fileBytes('loro.db-wal'),
    loroShmBytes: fileBytes('loro.db-shm'),
    roostWalBytes: fileBytes('history.db-wal'),
    roostShmBytes: fileBytes('history.db-shm'),
  });
  const page = async (from: number, to: number) => {
    const directory = await backend.readHistoryDirectory(from, to);
    const turns = [];
    for (const row of directory) {
      if (!row.turnId) throw new Error('Expected directory identity');
      const value = await backend.readTurn(row.turnId);
      expect(value.state).toBe('ready');
      turns.push(value);
    }
    return turns.length;
  };
  const checkAll = async (entries: Awaited<ReturnType<typeof backend.readHistory>>) => {
    expect(entries.length).toBe(rounds * 2);
    for (let round = 0; round < rounds; round++) {
      const u = entries[round * 2],
        a = entries[round * 2 + 1];
      expect(u.id).toBe(`user-${round}`);
      expect(a.id).toBe(`assistant-${round}`);
      expect(u.role).toBe('user');
      expect(
        u.items
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('')
      ).toBe(text(`user/${round}`, 256));
      if (mixed) {
        const expected = [assistantFixture(round)];
        for (let i = 0; i < chunks; i++)
          applyNotificationOnHistory(expected, updates(round, i), undefined, {
            targetAssistantEntryId: a.id,
          });
        expect(canonical(a.items)).toEqual(canonical(expected[0]?.items));
        expect(a.plan).toEqual(expected[0]?.plan);
      } else {
        const expected = Array.from({ length: chunks }, (_, i) =>
          text(`chunk/${round}/${i}`, chunkBytes)
        ).join('');
        expect(
          a.items
            .filter((x) => x.type === 'text')
            .map((x) => x.text)
            .join('')
        ).toBe(expected);
      }
      const tool = a.items.find((x) => x.type === 'tool_call');
      expect(tool && tool.type === 'tool_call' && tool.rawOutput).toEqual({
        text: text(`tool/${round}`, toolBytes),
      });
      expect(a.role === 'assistant' && a.finished).toBe(true);
    }
    const json = JSON.stringify(entries);
    // Compare business content across backends without storage-specific timestamps/metadata.
    const content = entries.map((e) => ({
      id: e.id,
      role: e.role,
      items: e.items,
      ...(mixed ? { plan: e.plan } : {}),
    }));
    return {
      visibleJsonBytes: Buffer.byteLength(json),
      fullDigest: digest(json),
      contentDigest: digest(JSON.stringify(content)),
      canonicalContentDigest: digest(JSON.stringify(canonical(content))),
    };
  };
  try {
    if (stage === 'paging') {
      const samples: number[] = [];
      const ids: string[] = [];
      const reader = backend.history;
      let cursor: string | null = null;
      let end = rounds * 2;
      do {
        const measured = await timer(async () => {
          const p =
            reader.readLatestDirectoryPage && reader.readOlderDirectoryPage
              ? cursor
                ? await reader.readOlderDirectoryPage(cursor, 20)
                : await reader.readLatestDirectoryPage(20)
              : {
                  rows: await backend.readHistoryDirectory(Math.max(0, end - 20), end),
                  startPosition: Math.max(0, end - 20),
                  cursor: null,
                };
          for (const row of p.rows) {
            if (!row.turnId) throw new Error('Expected cursor page identity');
            const read = await backend.readTurn(row.turnId);
            expect(read.state).toBe('ready');
            ids.push(row.turnId);
          }
          return p;
        });
        samples.push(measured.ms);
        cursor = measured.value.cursor;
        end = measured.value.startPosition;
        memory();
      } while (end > 0);
      expect(ids.length).toBe(rounds * 2);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(
        Array.from({ length: rounds }, (_, i) => [`user-${i}`, `assistant-${i}`])
          .flat()
          .sort()
      );
      await writeFile(
        join(dir, `paging${sampleSuffix}.json`),
        JSON.stringify(
          {
            kind,
            stage,
            rounds,
            chunks,
            pageSize: 20,
            openMs: opened.ms,
            pages: stats(samples),
            samples,
            method: reader.readOlderDirectoryPage ? 'cursor' : 'position',
            rssAtStart,
            trajectory,
            peakRss,
            memory: memory(),
            totalMs: performance.now() - started,
          },
          null,
          2
        )
      );
      return;
    }
    if (stage === 'reopen') {
      const before = JSON.parse(await readFile(join(dir, 'write.json'), 'utf8'));
      const latest = await timer(() => page(Math.max(0, rounds * 2 - 20), rounds * 2));
      const startupToLatestMs = performance.now() - started;
      const rssAfterLatest = memory().rss;
      memory('latest-window');
      const oldest = await timer(() => page(0, Math.min(20, rounds * 2)));
      const full = await timer(() => backend.readHistory());
      const rssAfterFullRead = memory().rss;
      memory('after-full-materialization');
      const checked = await checkAll(full.value);
      expect(checked.fullDigest).toBe(before.fullDigest);
      const result = {
        stage,
        kind,
        rounds,
        chunks,
        openMs: opened.ms,
        latestPageMs: latest.ms,
        oldestPageMs: oldest.ms,
        fullReadMs: full.ms,
        startupToLatestMs,
        rssAfterLatest,
        rssAfterFullRead,
        ...checked,
        ...size(),
        rssAtStart,
        trajectory,
        peakRss: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
        memory: memory(),
        cpuMs: cpuMs(process.cpuUsage(cpuStart)),
        totalMs: performance.now() - started,
      };
      await writeFile(join(dir, `reopen${sampleSuffix}.json`), JSON.stringify(result, null, 2));
      return;
    }
    await repo.flush();
    const empty = size();
    const rssAfterOpen = memory().rss;
    const samples: number[] = [],
      liveChanges: number[] = [],
      appendMs: number[] = [],
      userCreationMs: number[] = [],
      assistantCreationMs: number[] = [],
      resumeMs: number[] = [],
      firstResumedAppendMs: number[] = [],
      finishMs: number[] = [];
    const categories: Record<string, number[]> = {};
    const windows: unknown[] = [];
    let checkpoint = await backend.history.getCheckpoint?.();
    const initialCheckpoint = checkpoint;
    let writeCpuMs = 0;
    let windowStart = 0;
    const report = async (completed: number) => {
      memory(`before-window-read-${completed}`);
      const count = await backend.readHistoryCount();
      const last = await timer(() => page(Math.max(0, count - 20), count));
      const first = await timer(() => page(0, Math.min(count, 20)));
      const warm: number[] = [];
      for (let i = 0; i < 9; i++)
        warm.push((await timer(() => page(Math.max(0, count - 20), count))).ms);
      const row = {
        completedUpdates: completed,
        messages: count,
        writes: stats(samples.slice(windowStart)),
        latestPageMs: last.ms,
        oldestPageMs: first.ms,
        warmLatestPage: stats(warm),
        memory: memory(),
        ...size(),
        elapsedMs: performance.now() - started,
      };
      windows.push(row);
      windowStart = samples.length;
      await appendFile(join(dir, 'progress.jsonl'), JSON.stringify(row) + '\n');
    };
    const milestones = new Set([
      100,
      1000,
      5000,
      rounds * chunks,
      ...[64, 256, 1024].map((kib) => Math.ceil((kib * 1024) / chunkBytes)),
    ]);
    let completed = 0;
    for (let round = 0; round < rounds; round++) {
      const user: SessionHistoryInput = {
        id: `user-${round}`,
        role: 'user',
        userId: 'test-user',
        timestamp: '2026-10-22T00:00:00.000Z',
        status: 'pending',
        read: false,
        items: [{ type: 'text', text: text(`user/${round}`, 256) }],
        fileDiff: [],
      };
      const assistant = assistantFixture(round);
      for (const entry of [user, assistant]) {
        const measured = await timer(async () => {
          await backend.appendHistoryTurn(entry);
          await persist();
        });
        appendMs.push(measured.ms);
        (entry.role === 'user' ? userCreationMs : assistantCreationMs).push(measured.ms);
      }
      checkpoint = await backend.history.getCheckpoint?.();
      for (let i = 0; i < chunks; i++) {
        if (mixed && i === Math.floor(chunks / 2)) {
          resumeMs.push(
            (
              await timer(async () => {
                await backend.applyHistoryAction({
                  kind: 'finish-assistant',
                  turnId: assistant.id,
                  endedAt: 21,
                });
                await persist();
                await backend.openAssistantTurn({ turnId: assistant.id, userTurnId: user.id });
                await persist();
              })
            ).ms
          );
          checkpoint = await backend.history.getCheckpoint?.();
        }
        const notifications = updates(round, i);
        const input = {
          targetAssistantEntryId: assistant.id,
          notifications,
          operationIds: notifications.map((_, n) => `notification-${round}-${i}-${n}`),
        };
        const cpu = process.cpuUsage();
        samples.push(
          (
            await timer(async () => {
              await backend.applyAgentBatch(input);
              await persist();
            })
          ).ms
        );
        writeCpuMs += cpuMs(process.cpuUsage(cpu));
        const elapsed = samples.at(-1);
        assert.ok(elapsed !== undefined);
        const category =
          notifications.length > 1
            ? 'textToolPlanBatch'
            : mixed && (i === 0 || i === Math.floor(chunks / 3))
              ? 'textMarkup'
              : 'text';
        (categories[category] ??= []).push(elapsed);
        if (mixed && i === Math.floor(chunks / 2)) firstResumedAppendMs.push(elapsed);
        completed++;
        // Incremental consumer measurement is separate from durable write time.
        if (checkpoint && backend.history.readChanges) {
          const live = await timer(() =>
            backend.history.readChanges!(checkpoint!, { withPatches: true })
          );
          liveChanges.push(live.ms);
          expect(live.value.state).toBe('ready');
          checkpoint = live.value.checkpoint;
        }
        memory();
        if (milestones.has(completed)) await report(completed);
        if (kind === 'roost' && i === chunks - 1) {
          const beforeRetry = JSON.stringify(await backend.readTurn(assistant.id));
          await backend.applyAgentBatch(input);
          expect(JSON.stringify(await backend.readTurn(assistant.id))).toBe(beforeRetry);
        }
      }
      finishMs.push(
        (
          await timer(async () => {
            await backend.applyHistoryAction({
              kind: 'finish-assistant',
              turnId: assistant.id,
              endedAt: 42,
            });
            await persist();
          })
        ).ms
      );
    }
    const rssBeforeValidation = memory('before-full-validation').rss;
    const peakRssBeforeValidation = peakRss;
    const fullRead = await timer(() => backend.readHistory());
    memory('after-full-materialization');
    const final = await checkAll(fullRead.value);
    let catchUp;
    if (initialCheckpoint && backend.history.readChanges) {
      const result = await timer(() =>
        backend.history.readChanges!(initialCheckpoint, { withPatches: true })
      );
      catchUp = { ms: result.ms, resultBytes: Buffer.byteLength(JSON.stringify(result.value)) };
    }
    await repo.flush();
    memory();
    const result = {
      stage,
      kind,
      rounds,
      chunks,
      chunkBytes,
      toolBytes,
      mixed,
      ...final,
      empty,
      ...size(),
      writes: stats(samples),
      append: stats(appendMs),
      userCreation: stats(userCreationMs),
      assistantCreation: stats(assistantCreationMs),
      writeCategories: Object.fromEntries(
        Object.entries(categories).map(([key, values]) => [key, stats(values)])
      ),
      resume: stats(resumeMs),
      firstResumedAppend: stats(firstResumedAppendMs),
      finish: stats(finishMs),
      liveChanges: stats(liveChanges),
      catchUp,
      windows,
      samples,
      writeCpuMs,
      rssAtStart,
      trajectory,
      rssAfterOpen,
      rssBeforeValidation,
      peakRssBeforeValidation,
      fullReadMs: fullRead.ms,
      peakRss: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
      memory: memory(),
      cpuMs: cpuMs(process.cpuUsage(cpuStart)),
      totalMs: performance.now() - started,
      retryVerified: kind === 'roost',
      durability: 'SQLite WAL + synchronous=FULL, barrier per action',
    };
    await writeFile(join(dir, 'write.json'), JSON.stringify(result, null, 2));
  } finally {
    await doc.destroy({ preserveStatus: true });
    await repo.destroy();
    store.close();
    control.close();
    await writeFile(
      join(dir, `release-${stage}${sampleSuffix}.json`),
      JSON.stringify({ phase: 'after-release', ...memory('after-release') }, null, 2)
    );
  }
}, 1800000);
