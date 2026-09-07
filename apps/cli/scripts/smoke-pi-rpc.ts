/** Explicit integration smoke: installs pinned Pi, uses a synthetic offline model and a temporary home. */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/session/session-execution-helpers';
import { createAcpClient } from '../src/agent/acp-runner';
import { createAgentStream } from '../src/agent/agent-connection';
import { resolveACPProcessLaunchAsync } from '../src/agent/setting';
import type { Logger } from '../src/utils/logger';
import type { ACPSessionId } from '@lody/shared';

const root = await mkdtemp(join(tmpdir(), 'lody-pi-rpc-smoke-'));
const fixture = fileURLToPath(
  new URL('../src/agent/pi-rpc/fixtures/provider.mjs', import.meta.url)
);
const log = () => undefined;
const logger: Logger = {
  debug: log,
  info: log,
  warn: log,
  error: log,
  success: log,
  setLevel: log,
  setDebug: log,
  child: () => logger,
  close: async () => undefined,
};
const children = new Set<ReturnType<typeof spawn>>();
const output: string[] = [];
let onToolStart: (() => void) | undefined;
let onPromptAck: (() => void) | undefined;

async function start(resumeSessionId?: ACPSessionId) {
  const config = { cliType: 'builtin' as const, agentType: 'pi' };
  const launch = await resolveACPProcessLaunchAsync({
    ...config,
    extraArgs: [
      '--provider',
      'lody-fixture',
      '--model',
      'fixture',
      '--no-extensions',
      '-e',
      fixture,
    ],
  });
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: join(root, '.pi'),
      npm_config_cache: join(root, 'npm-cache'),
      PI_SKIP_VERSION_CHECK: '1',
    },
  });
  children.add(child);
  let wire = '';
  child.stdout?.on('data', (data) => {
    wire += data.toString();
    let end;
    while ((end = wire.indexOf('\n')) >= 0) {
      const event = JSON.parse(wire.slice(0, end));
      wire = wire.slice(end + 1);
      if (event.type === 'response' && event.command === 'prompt' && event.success) onPromptAck?.();
    }
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Missing Pi stdio');
  child.stderr.on('data', (data) => process.stderr.write(data));
  const started = await createAcpClient({
    stream: createAgentStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), config),
    workdir: root,
    logger,
    terminalManager: {} as never,
    agentConfig: config,
    resumeSessionId,
    onUpdateMessage: (n) => {
      if (n.update.sessionUpdate === 'tool_call' && n.update.title === 'fixture_gate')
        onToolStart?.();
      if (n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text')
        output.push(n.update.content.text);
    },
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  return {
    ...started,
    releaseGate: () =>
      child.stdin!.write(
        JSON.stringify({ id: 'smoke-release', type: 'prompt', message: '/release-fixture' }) + '\n'
      ),
    stop: async () => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      children.delete(child);
    },
  };
}
try {
  const first = await start();
  const prompt = (text: string) =>
    first.client.prompt(first.acpSessionId, [{ type: 'text', text }]);
  assert.equal(
    (
      await prompt(
        buildPrompt('write fixture', undefined, undefined, undefined, {
          cliType: 'builtin',
          agentType: 'pi',
        })
      )
    )?.stopReason,
    'end_turn'
  );
  assert.equal(await readFile(join(root, 'fixture.txt'), 'utf8'), 'native pi wrote this\n');
  assert.equal((await prompt('handled fixture'))?.stopReason, 'end_turn');
  assert.equal((await prompt('/ask-fixture'))?.stopReason, 'end_turn');
  assert.equal(
    (
      await prompt(
        buildPrompt('/stats', undefined, undefined, undefined, {
          cliType: 'builtin',
          agentType: 'pi',
        })
      )
    )?.stopReason,
    'end_turn'
  );
  const gateStarted = new Promise<void>((resolve) => {
    onToolStart = resolve;
  });
  const running = prompt('gate fixture');
  await gateStarted;
  onPromptAck = () => {
    onPromptAck = undefined;
    first.releaseGate();
  };
  const steering = first.client.steerPrompt(first.acpSessionId, [
    { type: 'text', text: 'steered fixture' },
  ]);
  const lease = await steering.applied;
  assert(!output.includes('Pi steer applied'), 'output must wait for ownership transfer');
  lease.release();
  await running;
  assert(output.includes('Pi steer applied'));
  const nativeSessionFile = first.acpSessionId;
  await first.stop();
  const resumed = await start(nativeSessionFile);
  assert.equal(
    (await resumed.client.prompt(resumed.acpSessionId, [{ type: 'text', text: 'continue' }]))
      ?.stopReason,
    'end_turn'
  );
  await resumed.stop();
  assert(output.includes('Pi native smoke passed'));
  assert(output.some((line) => line.startsWith('Pi session usage:')));
  console.log(
    'PASS: native launch, AgentClient, tool write, handled input, dialog cancellation, stats, acknowledged steer, and restart/resume.'
  );
  console.log(`Synthetic artifacts retained at ${root}`);
} finally {
  for (const child of children) child.kill();
}
