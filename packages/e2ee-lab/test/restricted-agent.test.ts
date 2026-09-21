import { afterEach, describe, expect, it } from 'vitest';
import { writeLoro } from '../src/platform/content-session';
import { toHex } from '../src/platform/bytes';
import { exportDevice } from '../src/platform/device';
import {
  createAttackLab,
  harnessReplayMaterial,
  inspectClient,
  replayAttackActions,
} from '../src/attack-lab';
import { writeFileSync } from 'node:fs';
import {
  collabModelAgent,
  listAgentEndpoints,
  runRestrictedAgentWithFallback,
} from '../src/restricted-agent';
import {
  collabScript,
  createCollabWorld,
  replayCollabScenario,
  runCollabScenario,
} from '../src/scenario';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { isRecordingEntropy, recordingEntropy, replayEntropy } from '../src/entropy';
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
    const entropy = recordingEntropy();
    const alice = await labClient({ host, account: 'alice', runtime, entropy });
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
      inspectHonest: inspectClient(alice, host),
    });
    const { report, endpoint } = await runRestrictedAgentWithFallback(lab, endpoints);
    const material = await harnessReplayMaterial(lab);
    const recorded = material.actions;
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
      entropy: replayEntropy(isRecordingEntropy(entropy) ? entropy.fills : []),
      device: await exportDevice(alice.device),
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    expect(replayAlice.genesisHex).toBe(alice.genesisHex);
    await writeLoro(replayAlice, secret);
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: replayRuntime,
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: secret,
      genesisHex: replayAlice.genesisHex,
      inspectHonest: inspectClient(replayAlice, replayHost),
    });
    const replayed = await replayAttackActions(replayLab, material.actions, {
      events: material.events,
      frames: material.frames,
      clients: material.clients,
      report,
    });
    expect(replayed.divergence).toBeNull();
    expect(replayed.report.confidentiality).toBe(report.confidentiality);
    expect(replayed.report.integrity).toBe(report.integrity);
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
            replayed: replayed.report,
            divergence: replayed.divergence,
          },
          null,
          2
        )}\n`
      );
    }
  }, 90_000);

  it('lets a real model intervene mid-collaboration and replays it model-free', async () => {
    const endpoints = listAgentEndpoints();
    if (endpoints.length === 0) {
      throw new Error('no model key; real-Agent collab run blocked');
    }
    // Probe endpoints once so a dead key does not silently pass as 'pass'.
    let agent: ReturnType<typeof collabModelAgent> | undefined;
    let endpointUsed: (typeof endpoints)[number] | undefined;
    let probeError: unknown;
    for (const endpoint of endpoints) {
      const candidate = collabModelAgent(endpoint);
      try {
        await candidate.act({
          step: 0,
          stepName: 'probe',
          turn: 0,
          remainingSteps: collabScript().map((step) => step.name),
          view: { events: [], genesisHex: null, backendBytes: 0, errors: [] },
          readBackend: async () => new Uint8Array(),
        });
        agent = candidate;
        endpointUsed = endpoint;
        break;
      } catch (error) {
        probeError = error;
      }
    }
    if (!agent || !endpointUsed) {
      throw new Error(`model endpoints unavailable: ${String(probeError)}`);
    }

    const world = await createCollabWorld({ mode: 'manual' });
    const run = await runCollabScenario({
      world,
      agent,
      maxTurnsPerStep: 2,
      maxActions: 24,
    });
    // The honest program stayed deterministic; only attack-side errors are
    // allowed (a failed agent turn or a step the attack broke).
    const scriptErrors = run.outcomes.filter(
      (outcome) => outcome.error && !outcome.name.startsWith('agent:')
    );
    const attackActions = run.material.actions.filter(
      (action) => action.op === 'intercept' || action.op === 'mutateBackend'
    );
    // A real attack, chosen while collaboration was in flight — not just
    // observe/readBackend/submitClaim/finish.
    expect(attackActions.length).toBeGreaterThan(0);
    const attackIndex = run.material.actions.findIndex((action) => action === attackActions[0]);
    expect(run.material.marks[attackIndex]).toBeLessThan(collabScript().length);
    const interceptIds = new Set(
      attackActions
        .filter((action) => action.op === 'intercept')
        .map((action) => String(action.input?.eventId ?? ''))
    );
    const intercepted = run.material.frames.some(
      (frame) =>
        interceptIds.has(frame.eventId) &&
        (frame.responseStatus === 0 || frame.responseHex.length > 0)
    );
    const mutated = run.material.actions.some(
      (action) => action.op === 'mutateBackend' && action.input?.receipt === true
    );
    expect(intercepted || mutated).toBe(true);
    expect(JSON.stringify(run.lab.actions())).not.toContain(world.secret);

    // Same record replays model-free in three fresh directory sets.
    const replays = [] as Awaited<ReturnType<typeof replayCollabScenario>>[];
    for (let runIndex = 0; runIndex < 3; runIndex++) {
      const entry = await replayCollabScenario(run.material);
      replays.push(entry);
      expect(entry.divergence).toBeNull();
      const replayScriptErrors = entry.outcomes.filter(
        (outcome) => outcome.error && !outcome.name.startsWith('agent:')
      );
      expect(replayScriptErrors.map((o) => o.name)).toEqual(scriptErrors.map((o) => o.name));
    }

    const evidence = process.env.E2EE_AGENT_EVIDENCE;
    if (evidence) {
      writeFileSync(
        evidence,
        `${JSON.stringify(
          {
            host: new URL(endpointUsed.url).host,
            model: endpointUsed.model,
            attackOps: attackActions.map((action) => action.op),
            marks: run.material.marks,
            hit: { intercepted, mutated },
            report: run.report,
            replays: replays.map((r) => ({ report: r.report, divergence: r.divergence })),
          },
          null,
          2
        )}\n`
      );
    }
  }, 300_000);
});
