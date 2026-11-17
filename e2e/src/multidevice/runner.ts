import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import { quoteCommandArgument } from '../support/fixtures/command-line.js';
import {
  assertIndependentActors,
  type Backend,
  type CloudFixture,
  type DesktopRound,
  type Membership,
} from './contract.js';
import { SyncSessionUi } from './session-ui.js';

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactBase = join(suiteRoot, 'artifacts', 'multidevice');
mkdirSync(artifactBase, { recursive: true });
const artifacts = mkdtempSync(join(artifactBase, 'round-'));
const results: unknown[] = [];
function save(status: string, reason?: string) {
  writeFileSync(
    join(artifacts, 'result.json'),
    JSON.stringify({ status, reason, results }, null, 2) + '\n'
  );
}
function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function run(fixture: CloudFixture, membership: Membership, backend: Backend): Promise<void> {
  const root = join(artifacts, membership);
  mkdirSync(root);
  const signals = join(root, 'signals');
  mkdirSync(signals);
  const logs = [join(root, 'agent-a.ndjson'), join(root, 'agent-b.ndjson')];
  for (const log of logs) writeFileSync(log, '');
  const commands = logs.map((log) =>
    [process.execPath, join(suiteRoot, 'fixtures/sync-scripted-acp.mjs'), log, signals]
      .map(quoteCommandArgument)
      .join(' ')
  ) as [string, string];
  let round: DesktopRound | undefined;
  let primaryError: unknown;
  try {
    // Fixture owns cleanup of resources acquired before createRound returns.
    round = await fixture.createRound({
      membership,
      backend,
      root,
      artifacts: root,
      agentCommands: commands,
    });
    const actors = round.actors;
    const observations = await assertIndependentActors(actors, root, membership, backend);
    writeFileSync(join(root, 'replicas.json'), JSON.stringify(observations, null, 2) + '\n');
    const tokens: string[] = [];
    let sessionId = '';
    const ui = (i: number) => new SyncSessionUi(actors[i]!.page);
    const starts = (token: string, event: string) =>
      logs
        .flatMap((log) =>
          readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as { token?: string; event?: string }];
              } catch {
                return [];
              }
            })
        )
        .filter((entry) => entry.token === token && entry.event === event);
    const complete = async (sender: number, token: string, fresh = false, peerOnline = true) => {
      await ui(sender).send(token, fresh);
      if (fresh) {
        sessionId = ui(sender).sessionId();
        await ui(1 - sender).open(sessionId);
      }
      await ui(sender).expectStreaming(token);
      if (peerOnline) await ui(1 - sender).expectStreaming(token);
      await expect.poll(() => starts(token, 'start').length, { timeout: 30_000 }).toBe(1);
      writeFileSync(join(signals, token), 'release\n', { flag: 'wx' });
      tokens.push(token);
      await ui(sender).expectHistory(tokens);
      if (peerOnline) await ui(1 - sender).expectHistory(tokens);
      await expect.poll(() => starts(token, 'complete').length, { timeout: 30_000 }).toBe(1);
    };
    await complete(0, 'a-initial', true);
    await complete(1, 'b-followup');
    await actors[1].setOnline(false);
    await complete(0, 'a-while-b-offline', false, false);
    await ui(1).expectMissing('a-while-b-offline');
    const previous = actors[1];
    const previousProcess = previous.app.process();
    actors[1] = await previous.restart(); // Restart must preserve the network gate.
    assert.ok(
      previousProcess.exitCode !== null || previousProcess.signalCode !== null,
      'Restart left the old Electron process alive'
    );
    const restarted = await assertIndependentActors(actors, root, membership, backend);
    for (const field of [
      'accountId',
      'workspaceId',
      'machineId',
      'userDataDir',
      'dataDir',
      'repoDir',
    ] as const) {
      assert.equal(restarted[1][field], observations[1][field], `Restart changed device ${field}`);
    }
    await ui(1).open(sessionId);
    await ui(1).expectHistory(tokens.slice(0, 2));
    await ui(1).expectMissing('a-while-b-offline');
    writeFileSync(join(root, 'restarted-replicas.json'), JSON.stringify(restarted, null, 2) + '\n');
    await actors[1].setOnline(true);
    await ui(1).open(sessionId);
    await ui(1).expectHistory(tokens);
    await complete(1, 'b-after-restart');
    // Restart the execution owner too: renderer reload alone cannot prove its
    // daemon/Repo persisted the accepted conversation.
    const ownerProcess = actors[0].app.process();
    actors[0] = await actors[0].restart();
    assert.ok(
      ownerProcess.exitCode !== null || ownerProcess.signalCode !== null,
      'Owner restart left the old process alive'
    );
    const ownerRestarted = await assertIndependentActors(actors, root, membership, backend);
    for (const field of [
      'accountId',
      'workspaceId',
      'machineId',
      'userDataDir',
      'dataDir',
      'repoDir',
    ] as const) {
      assert.equal(
        ownerRestarted[0][field],
        observations[0][field],
        `Owner restart changed ${field}`
      );
    }
    await ui(0).open(sessionId);
    await ui(0).expectHistory(tokens);
    await ui(1).expectHistory(tokens);
    for (const token of tokens)
      assert.equal(starts(token, 'start').length, 1, `Duplicate ACP dispatch: ${token}`);
    for (let i = 0; i < actors.length; i++) {
      await actors[i]!.page.screenshot({
        path: join(root, `actor-${i}-complete.png`),
        fullPage: true,
      });
    }
    results.push({ membership, backend, sessionId, tokens, status: 'passed' });
  } catch (error) {
    primaryError = error;
    results.push({ membership, backend, status: 'failed', error: String(error) });
  } finally {
    try {
      await round?.close();
    } catch (error) {
      primaryError = primaryError
        ? new AggregateError([primaryError, error], 'Scenario and cleanup failed')
        : error;
    }
  }
  if (primaryError) throw primaryError;
}

async function main() {
  const adapter = argument('--adapter');
  if (!adapter) {
    save(
      'blocked',
      'A private isolated Cloud fixture is required: --adapter /absolute/path/fixture.ts. OSS Electron cannot authenticate or synchronize product workspaces.'
    );
    console.error(
      `Multi-device acceptance BLOCKED: provide a private Cloud fixture. Evidence: ${artifacts}`
    );
    process.exitCode = 2;
    return;
  }
  const backend = argument('--backend') ?? 'legacy';
  assert.ok(backend === 'legacy' || backend === 'native', '--backend must be legacy or native');
  const fixture = (await import(pathToFileURL(resolve(adapter)).href)).default as CloudFixture;
  assert.equal(
    typeof fixture?.createRound,
    'function',
    'Adapter must default-export a CloudFixture'
  );
  for (const membership of ['same-account', 'different-members'] as const)
    await run(fixture, membership, backend);
  save('passed');
  console.log(`Multi-device acceptance passed: ${artifacts}`);
}
try {
  await main();
} catch (error) {
  save('failed', String(error));
  console.error(error);
  console.error(`Evidence: ${artifacts}`);
  process.exitCode = 1;
}
