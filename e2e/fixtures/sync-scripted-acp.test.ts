import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { it } from 'node:test';
import * as acp from '@agentclientprotocol/sdk';

void it(
  'holds two actual ACP prompts independently until their exact file barriers release',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'lody-sync-acp-'));
    const log = join(root, 'events.ndjson');
    const child = spawn(process.execPath, [resolve('fixtures/sync-scripted-acp.mjs'), log, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    const updates: string[] = [];
    const started = new Map<string, () => void>();
    const client = acp
      .client({ name: 'sync-fixture-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (
          params.update.sessionUpdate !== 'agent_message_chunk' ||
          params.update.content.type !== 'text'
        )
          return;
        const text = params.update.content.text;
        updates.push(text);
        started.get(text)?.();
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin!),
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
        )
      );
    try {
      await client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const a = await client.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: [],
      });
      const b = await client.agent.request(acp.methods.agent.session.new, {
        cwd: root,
        mcpServers: [],
      });
      const startA = new Promise<void>((ready) => started.set('SYNC_STARTED_alpha', ready));
      const startB = new Promise<void>((ready) => started.set('SYNC_STARTED_beta', ready));
      const promptA = client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: a.sessionId,
        prompt: [{ type: 'text', text: '[SYNC:alpha]' }],
      });
      const promptB = client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: b.sessionId,
        prompt: [{ type: 'text', text: '[SYNC:beta]' }],
      });
      await Promise.all([startA, startB]);
      writeFileSync(join(root, 'beta'), 'release');
      assert.equal((await promptB).stopReason, 'end_turn');
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; token: string });
      assert.deepEqual(
        events.filter((event) => event.event === 'complete').map((event) => event.token),
        ['beta']
      );
      assert.ok(!updates.includes('\n\nSYNC_REPLY_alpha'));
      writeFileSync(join(root, 'alpha'), 'release');
      assert.equal((await promptA).stopReason, 'end_turn');
      assert.ok(updates.includes('\n\nSYNC_REPLY_alpha'));
      assert.ok(updates.includes('\n\nSYNC_REPLY_beta'));
      const title = await client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: a.sessionId,
        prompt: [
          { type: 'text', text: 'You generate titles for coding sessions. [SYNC:title-token]' },
        ],
      });
      assert.equal(title.stopReason, 'end_turn');
      assert.ok(!readFileSync(log, 'utf8').includes('title-token'));
    } finally {
      await client.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }
);
