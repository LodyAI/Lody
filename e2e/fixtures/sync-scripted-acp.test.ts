import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { it, type TestContext } from 'node:test';
import * as acp from '@agentclientprotocol/sdk';

const fixturePath = fileURLToPath(new URL('./sync-scripted-acp.mjs', import.meta.url));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
function bounded<T>(work: PromiseLike<T> | T, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    // A cleanup deadline never confirms release. Escalation still awaits the
    // exact owned child's close receipt before removing its temporary directory.
    const timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 2_000);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
async function withFixture(
  t: Pick<TestContext, 'signal'>,
  work: (fixture: {
    root: string;
    log: string;
    client: ReturnType<ReturnType<typeof acp.client>['connect']>;
    updates: string[];
    step: <T>(label: string, work: Promise<T>) => Promise<T>;
    started: (token: string, prompt: Promise<unknown>) => Promise<void>;
    kill: () => void;
  }) => Promise<void>,
  options: { missingSignals?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'lody-sync-acp-'));
  const log = join(root, 'events.ndjson');
  const child = spawn(
    process.execPath,
    [fixturePath, log, options.missingSignals ? join(root, 'missing-signals') : root],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const closed = deferred<void>(),
    failed = deferred<never>();
  let closing = false,
    phase = 'starting',
    stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-16 * 1024);
  });
  child.once('error', (error) => failed.reject(error));
  child.once('close', (code, signal) => {
    closed.resolve();
    if (!closing) failed.reject(new Error(`Fixture closed: code=${code} signal=${signal}`));
  });
  const aborted = () => failed.reject(t.signal.reason ?? new Error('Test aborted'));
  t.signal.addEventListener('abort', aborted, { once: true });
  if (t.signal.aborted) aborted();
  const updates: string[] = [];
  const waiters = new Map<string, () => void>();
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
      waiters.get(text)?.();
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );
  const diagnostics = () => {
    let events = '(no events)';
    try {
      events = readFileSync(log, 'utf8').slice(-16 * 1024);
    } catch {}
    return `phase=${phase}; pid=${child.pid}; exit=${child.exitCode}; signal=${child.signalCode}; artifacts=${root}\nstderr:\n${stderr}\nevents:\n${events}\nupdates:${JSON.stringify(updates.slice(-16))}`;
  };
  const step = async <T>(label: string, pending: Promise<T>): Promise<T> => {
    phase = label;
    return Promise.race([pending, failed.promise]);
  };
  let primary: unknown;
  try {
    await work({
      root,
      log,
      client,
      updates,
      step,
      started: async (token, prompt) => {
        const text = `SYNC_STARTED_${token}`;
        const ready = deferred<void>();
        if (updates.includes(text)) ready.resolve();
        else waiters.set(text, () => ready.resolve());
        try {
          await step(
            `waiting for ${token} barrier-ready notification`,
            Promise.race([
              ready.promise,
              prompt.then(() => {
                throw new Error(`${token} completed before its barrier-ready notification`);
              }),
            ])
          );
        } finally {
          waiters.delete(text);
        }
      },
      kill: () => {
        child.kill('SIGTERM');
      },
    });
  } catch (error) {
    primary = new Error(`Sync ACP protocol failed: ${diagnostics()}`, { cause: error });
  }
  const failures: unknown[] = [];
  closing = true;
  t.signal.removeEventListener('abort', aborted);
  // A test timeout does not interrupt a pending ACP promise. End the owned
  // provider and confirm its pipe EOF before forgetting any held request.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try {
    await bounded(closed.promise, 'Owned fixture SIGTERM');
  } catch {
    child.kill('SIGKILL');
    try {
      await bounded(closed.promise, 'Owned fixture SIGKILL');
    } catch (error) {
      failures.push(error);
    }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  try {
    await bounded(client.close(), 'ACP client close after provider exit');
  } catch (error) {
    failures.push(error);
  }
  if (!primary && !failures.length) rmSync(root, { recursive: true, force: true });
  if (failures.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...failures],
      `Sync ACP cleanup unconfirmed: ${diagnostics()}`
    );
  if (primary) throw primary;
}

void it(
  'holds two actual ACP prompts independently until their exact file barriers release',
  { timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, log, client, updates, step, started }) => {
      await step(
        'initialize',
        client.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        })
      );
      const a = await step(
        'create alpha session',
        client.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })
      );
      const b = await step(
        'create beta session',
        client.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })
      );
      const promptA = client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: a.sessionId,
        prompt: [{ type: 'text', text: '[SYNC:alpha]' }],
      });
      const promptB = client.agent.request(acp.methods.agent.session.prompt, {
        sessionId: b.sessionId,
        prompt: [{ type: 'text', text: '[SYNC:beta]' }],
      });
      void promptA.catch(() => {});
      void promptB.catch(() => {});
      await Promise.all([started('alpha', promptA), started('beta', promptB)]);
      writeFileSync(join(root, 'beta'), 'release');
      assert.equal(
        (await step('complete beta after its file signal', promptB)).stopReason,
        'end_turn'
      );
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
      assert.equal(
        (await step('complete alpha after its file signal', promptA)).stopReason,
        'end_turn'
      );
      assert.ok(updates.includes('\n\nSYNC_REPLY_alpha'));
      assert.ok(updates.includes('\n\nSYNC_REPLY_beta'));
      const title = await step(
        'title request bypasses the conversation barrier',
        client.agent.request(acp.methods.agent.session.prompt, {
          sessionId: a.sessionId,
          prompt: [
            { type: 'text', text: 'You generate titles for coding sessions. [SYNC:title-token]' },
          ],
        })
      );
      assert.equal(title.stopReason, 'end_turn');
      assert.ok(!readFileSync(log, 'utf8').includes('title-token'));
    });
  }
);

void it(
  'reports a real barrier setup failure before waiting for a started notification and reaps the child',
  { timeout: 30_000 },
  async (t) => {
    await assert.rejects(
      withFixture(
        t,
        async ({ root, client, step, started }) => {
          await step(
            'initialize',
            client.agent.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
            })
          );
          const session = await step(
            'new session',
            client.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })
          );
          const prompt = client.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '[SYNC:missing-directory]' }],
          });
          await started('missing-directory', prompt);
        },
        { missingSignals: true }
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof AggregateError), 'Cleanup must confirm the owned child exit');
        assert.match(error.message, /waiting for missing-directory barrier-ready notification/);
        assert.match(error.message, /barrier-failed/);
        assert.match(error.message, /ENOENT/);
        return true;
      }
    );
  }
);

void it(
  'reports an owned provider exit while a real prompt is held and closes without waiting for its barrier',
  { timeout: 30_000 },
  async (t) => {
    await assert.rejects(
      withFixture(t, async ({ root, client, step, started, kill }) => {
        await step(
          'initialize',
          client.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          })
        );
        const session = await step(
          'new session',
          client.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })
        );
        const prompt = client.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '[SYNC:held]' }],
        });
        await started('held', prompt);
        kill();
        await step('held prompt after owned child exit', prompt);
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof AggregateError), 'Cleanup must confirm the owned child exit');
        assert.match(error.message, /held prompt after owned child exit/);
        return true;
      }
    );
  }
);

void it(
  'interrupts a real held prompt on an explicit test abort and confirms child cleanup',
  { timeout: 30_000 },
  async () => {
    const controller = new AbortController();
    await assert.rejects(
      withFixture({ signal: controller.signal }, async ({ root, client, step, started }) => {
        await step(
          'initialize',
          client.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          })
        );
        const session = await step(
          'new session',
          client.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] })
        );
        const prompt = client.agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '[SYNC:aborted]' }],
        });
        await started('aborted', prompt);
        controller.abort(new Error('SYNTHETIC_TEST_ABORT'));
        await step('held prompt after explicit test abort', prompt);
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof AggregateError), 'Cleanup must confirm the owned child exit');
        assert.match(error.message, /held prompt after explicit test abort/);
        assert.ok(error.cause instanceof Error);
        assert.equal(error.cause.message, 'SYNTHETIC_TEST_ABORT');
        return true;
      }
    );
  }
);
