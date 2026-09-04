import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as acp from '@agentclientprotocol/sdk';

const fixturePath = resolve('fixtures/scripted-acp.mjs');
const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
  }
  children.clear();
});

void describe('scripted ACP fixture', () => {
  void it('streams a reply and settles a held prompt through cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lody-scripted-acp-test-'));
    const eventLog = join(root, 'events.ndjson');
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
