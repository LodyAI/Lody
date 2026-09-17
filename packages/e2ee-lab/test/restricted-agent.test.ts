import { afterEach, describe, expect, it } from 'vitest';
import { writeLoro } from '../src/platform/content-session';
import { toHex } from '../src/platform/bytes';
import {
  createAttackLab,
  harnessReplayActions,
  replayAttackActions,
  type AttackAction,
} from '../src/attack-lab';
import { writeFileSync } from 'node:fs';
import { listAgentEndpoints, runRestrictedAgentWithFallback } from '../src/restricted-agent';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

describe('P4 restricted LLM Agent', () => {
  it('runs a model-chosen AttackLab trace and replays it without an LLM', async () => {
    const endpoints = listAgentEndpoints();
    if (endpoints.length === 0) {
      throw new Error('no model key; P4 Agent run blocked');
    }
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await alice.readLedger();
    const secret = `agent-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    await writeLoro(alice, secret);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: secret,
      genesisHex: alice.genesisHex,
      inspectHonest: async () => {
        try {
          return {
            ledgerLength: (await alice.readLedger()).length,
            expectedLength: 1,
          };
        } catch {
          return { ledgerLength: 1, expectedLength: 1, importFailed: true };
        }
      },
    });
    const { report, endpoint } = await runRestrictedAgentWithFallback(lab, endpoints);
    const recorded = harnessReplayActions(lab);
    expect(recorded.some((action) => action.op === 'observe')).toBe(true);
    expect(recorded.some((action) => action.op === 'finish')).toBe(true);
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(lab.actions())).not.toContain(secret);
    expect(['pass', 'violation', 'unavailable']).toContain(report.confidentiality);

    const replayRuntime = new LabRuntime({ mode: 'auto' });
    const replayHost = await launchLab();
    const replayAlice = await labClient({
      host: replayHost,
      account: 'alice',
      runtime: replayRuntime,
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    await writeLoro(replayAlice, secret);
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: replayRuntime,
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: secret,
      genesisHex: replayAlice.genesisHex,
    });
    const replayed = await replayAttackActions(
      replayLab,
      harnessReplayActions(lab) as AttackAction[]
    );
    expect(replayed.confidentiality).toBe(report.confidentiality);
    expect(replayed.integrity).toBe(report.integrity);
    const evidence = process.env.E2EE_AGENT_EVIDENCE;
    if (evidence) {
      writeFileSync(
        evidence,
        `${JSON.stringify(
          {
            host: new URL(endpoint.url).host,
            model: endpoint.model,
            actions: recorded.map((action) => action.op),
            publicOps: lab.actions().map((action) => action.op),
            original: report,
            replayed,
          },
          null,
          2
        )}\n`
      );
    }
  }, 90_000);
});
