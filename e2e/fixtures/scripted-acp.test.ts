import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpCatalogFixture } from '../src/support/fixtures/mcp-catalog-fixture.js';
import { SessionForkFixture } from '../src/support/fixtures/session-fork-fixture.js';
import { WorkSessionFixture } from '../src/support/fixtures/work-session-fixture.js';

const fixturePath = resolve('fixtures/scripted-acp.mjs');
const children = new Set<ReturnType<typeof spawn>>();
const workFixtures = new Set<WorkSessionFixture>();
const forkFixtures = new Set<SessionForkFixture>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
  }
  children.clear();
  for (const fixture of workFixtures) fixture.dispose();
  workFixtures.clear();
  for (const fixture of forkFixtures) fixture.dispose();
  forkFixtures.clear();
});

void describe('scripted ACP fixture', () => {
  void it('uses the current MCP process for startup and cleanup when the scenario log path is reused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lody-mcp-fixture-test-'));
    const acpLog = join(root, 'acp.ndjson');
    const mcpLog = join(root, 'mcp.ndjson');
    const oldPid = 1;
    writeFileSync(
      acpLog,
      JSON.stringify({
        event: 'prompt-end',
        pid: oldPid,
        sessionId: 'old-round',
        stopReason: 'end_turn',
      }) + '\n'
    );
    writeFileSync(mcpLog, JSON.stringify({ event: 'process-start', pid: oldPid }) + '\n');
    const client = new Client({ name: 'mcp-fixture-test', version: '1' });
    try {
      const fixture = new McpCatalogFixture(acpLog, mcpLog);
      assert.deepEqual(fixture.readAcpEvents(), [], 'Old completion is not current-round evidence');
      assert.deepEqual(fixture.readMcpEvents(), [], 'Old PID cannot satisfy current MCP startup');
      await client.connect(
        new StdioClientTransport({ command: fixture.mcpCommand, args: fixture.mcpArgs })
      );
      await client.listTools();
      const started = await fixture.waitForMcpEvent('process-start');
      assert.notEqual(started.pid, oldPid);
      assert.equal(
        process.kill(started.pid, 0),
        true,
        'The verified MCP process is alive before cleanup'
      );
      await client.close();
      await fixture.expectMcpExited(started.pid);
      assert.equal((await fixture.waitForMcpEvent('process-start')).pid, started.pid);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it('isolates a fresh fork round from earlier source sessions and matches the real fork source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lody-fork-acp-test-'));
    const eventLog = join(root, 'events.ndjson');
    writeFileSync(
      eventLog,
      [
        { event: 'session-new', sessionId: 'stale-source', purpose: 'turn' },
        { event: 'prompt-end', sessionId: 'stale-source', turnId: 'stale-turn' },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n'
    );
    const fixture = await SessionForkFixture.create(eventLog);
    forkFixtures.add(fixture);
    assert.deepEqual(fixture.readEvents(), []);
    const child = spawn(
      process.execPath,
      [resolve('src/support/fixtures/session-fork-acp.mjs'), eventLog],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    children.add(child);
    const client = acp
      .client({ name: 'fork-fixture-test' })
      .onNotification(acp.methods.client.session.update, () => {})
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
      const session = await client.agent.request(acp.methods.agent.session.new, {
        cwd: fixture.projectRoot,
        mcpServers: [],
      });
      await client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Synthetic fork source' }],
      });
      const source = await fixture.waitForSourcePrompt();
      assert.equal(source.sessionId, session.sessionId);
      const fork = await client.agent.request(acp.methods.agent.session.fork, {
        sessionId: session.sessionId,
        cwd: fixture.projectRoot,
        _meta: { lody: { forkAtTurn: { turnId: source.turnId } } },
      });
      const event = fixture.readEvents().find((value) => value.event === 'session-fork');
      assert.equal(event?.sourceSessionId, source.sessionId);
      assert.equal(event?.sourceTurnId, source.turnId);
      assert.equal(event?.sessionId, fork.sessionId);
      assert.notEqual(fork.sessionId, source.sessionId);
    } finally {
      await client.close();
    }
    child.kill('SIGTERM');
    await new Promise<void>((done) => child.once('exit', () => done()));
    children.delete(child);
    rmSync(root, { recursive: true, force: true });
  });

  void it('streams a reply and settles a held prompt through cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lody-scripted-acp-test-'));
    const eventLog = join(root, 'events.ndjson');
    writeFileSync(eventLog, JSON.stringify({ event: 'prompt-end', mode: 'reply', pid: 1 }) + '\n');
    const workFixture = await WorkSessionFixture.create(eventLog);
    workFixtures.add(workFixture);
    assert.deepEqual(
      workFixture.readAcpEvents(),
      [],
      'A fresh Work round must not inherit completed turns from earlier runs'
    );
    const child = spawn(process.execPath, [fixturePath, eventLog], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    const updates: acp.SessionNotification[] = [];
    let resolveHeldPromptStarted: (() => void) | undefined;
    const client = acp
      .client({ name: 'scripted-fixture-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
        if (
          params.update.sessionUpdate === 'agent_message_chunk' &&
          params.update.content.type === 'text' &&
          params.update.content.text === 'Synthetic response started.'
        ) {
          resolveHeldPromptStarted?.();
        }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin!),
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
        )
      );

    const initialized = await client.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    assert.equal(initialized.agentInfo?.name, 'Lody Scripted E2E Agent');
    const session = await client.agent.request(acp.methods.agent.session.new, {
      cwd: root,
      mcpServers: [],
    });
    const reply = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '[SCOUT:REPLY]' }],
    });
    assert.equal(reply.stopReason, 'end_turn');
    assert.equal((await workFixture.waitForCompletedAgentPrompts(1)).length, 1);
    assert.ok(
      updates.some(
        (notification) =>
          notification.sessionId === session.sessionId &&
          notification.update.sessionUpdate === 'agent_message_chunk'
      )
    );

    const title = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [
        {
          type: 'text',
          text: 'You generate titles for coding sessions.\n<task_description>[SCOUT:HOLD]</task_description>',
        },
      ],
    });
    assert.equal(title.stopReason, 'end_turn');

    const heldPromptStarted = new Promise<void>((resolveStarted) => {
      resolveHeldPromptStarted = resolveStarted;
    });
    const held = client.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '[SCOUT:HOLD]' }],
    });
    await heldPromptStarted;
    resolveHeldPromptStarted = undefined;
    await client.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    assert.equal((await held).stopReason, 'cancelled');

    await client.close();
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    children.delete(child);
    const events = readFileSync(eventLog, 'utf8');
    assert.match(events, /"event":"session-cancel"/u);
    assert.match(events, /"mode":"title"/u);
    assert.match(events, /"stopReason":"cancelled"/u);
    rmSync(root, { recursive: true, force: true });
  });
});
