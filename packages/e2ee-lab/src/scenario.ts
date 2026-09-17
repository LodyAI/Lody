import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Entropy } from '@lody/e2ee-core';
import {
  applyAttackAction,
  createAttackLab,
  harnessReplayActions,
  harnessReplayMaterial,
  inspectClient,
  type AttackAction,
  type AttackLab,
  type BackendRead,
  type ClientDigest,
  type HonestInspect,
  type PublicReport,
  type PublicView,
} from './attack-lab';
import { firstReplayDivergence, type Divergence } from './replay';
import {
  bootstrapLoroFromSnapshot,
  loroWriter,
  readFlock,
  readLoro,
  uploadLoroSnapshot,
  writeFlock,
  writeLoro,
} from './platform/content-session';
import type { LabBackend } from './backend';
import { LabRuntime, type ProtocolFrame } from './runtime';
import type { LabEvent } from './scheduler';
import type { HonestClient } from './actors';
import { exportDevice, generateDevice, importDevice, type DemoDevice } from './platform/device';
import { isRecordingEntropy, recordingEntropy, replayEntropy, type EntropyFill } from './entropy';
import { drainUntil, labClient, launchLab, tempDir } from './fixtures';
import { toHex } from './platform/bytes';
import { persistLoroDocument } from './platform/persist';
import type { JoinRequestWire } from './platform/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export const COLLAB_SCENARIO = 'collab-v1';

const MEMBERS = ['alice', 'bob', 'carol', 'dave'] as const;
const EXTRA_DEVICES = ['spare', 'crash'] as const;

export interface CollabWorld {
  host: LabBackend;
  /** Follows host restarts; pass this — not `host` — to createAttackLab. */
  hostFacade: LabBackend;
  dataDir: string;
  runtime: LabRuntime;
  entropy: Entropy;
  devices: Record<string, DemoDevice>;
  deviceExports: Record<string, string>;
  dirs: Record<string, string>;
  clientDirs: string[];
  members: Record<(typeof MEMBERS)[number], HonestClient>;
  seeds: Record<string, string>;
  secret: string;
  genesisHex: string;
  joins: Record<string, JoinRequestWire | undefined>;
  offlineWriter?: ReturnType<typeof loroWriter>;
  /** Deterministic wall clock (Flock physicalTime, NOW_HEADER). */
  readonly now: () => number;
}

export interface CollabStep {
  readonly name: string;
  run(world: CollabWorld): Promise<void>;
}

export interface AgentTurn {
  readonly step: number;
  readonly stepName: string;
  readonly turn: number;
  /** Names of this and all later script steps, so a planning agent can pick a boundary. */
  readonly remainingSteps: readonly string[];
  readonly view: PublicView;
  readBackend(input: BackendRead): Promise<Uint8Array>;
}

/** Model or scripted attacker. `pass` lets the step drain untouched. */
export interface CollabAgent {
  act(turn: AgentTurn): Promise<AttackAction | readonly AttackAction[] | 'pass'>;
}

export interface CollabOutcome {
  readonly name: string;
  readonly error?: string;
}

/** Private replay bundle. Never exposed through AttackLab. */
export interface CollabMaterial {
  readonly version: 1;
  readonly scenario: string;
  readonly secret: string;
  readonly genesisHex: string;
  readonly devices: Record<string, string>;
  readonly seeds: Record<string, string>;
  readonly fills: readonly EntropyFill[];
  /** Step index that produced each recorded action (script.length = finish). */
  readonly marks: readonly number[];
  readonly actions: readonly AttackAction[];
  readonly events: readonly LabEvent[];
  readonly frames: readonly ProtocolFrame[];
  readonly clients: readonly ClientDigest[];
  readonly report: PublicReport;
}

export interface CollabRun {
  readonly outcomes: readonly CollabOutcome[];
  readonly report: PublicReport;
  readonly material: CollabMaterial;
  readonly lab: AttackLab;
}

function expectText(text: string, marker: string): void {
  if (!text.includes(marker)) throw new Error(`missing:${marker}:${text.slice(0, 64)}`);
}

/**
 * Skip one CBOR item, returning its end offset. Covers the fixed envelopeAad
 * shape `[32B hash, epoch uint, 32B key, 32B key]` — byte strings and
 * unsigned ints only.
 */
function cborItemEnd(body: Uint8Array, start: number): number {
  const head = body[start];
  if (head === undefined) throw new Error('cbor-truncated');
  const major = head >> 5;
  const info = head & 0x1f;
  const readUint = (at: number): { value: number; end: number } => {
    if (info < 24) return { value: info, end: at };
    const widths = { 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>;
    const width = widths[info];
    if (!width) throw new Error('cbor-unsupported');
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + (body[at + i] ?? 0);
    return { value, end: at + width };
  };
  if (major === 0) return readUint(start + 1).end;
  if (major === 2) {
    const length = readUint(start + 1);
    return length.end + length.value;
  }
  if (major === 4) {
    let cursor = start + 1;
    for (let i = 0; i < info; i++) cursor = cborItemEnd(body, cursor);
    return cursor;
  }
  throw new Error(`cbor-major:${major}`);
}

/** Frame = envelopeAad + enc(32) + ct(48) + sig(64); pages pack raw frames. */
function splitKeyFrames(body: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let cursor = 0;
  while (cursor < body.byteLength) {
    const end = cborItemEnd(body, cursor) + 144;
    frames.push(body.subarray(cursor, end));
    cursor = end;
  }
  return frames;
}

/**
 * Key-delivery frames arrive as raw envelopes packed inside stream pages.
 * Split the pages and take the last frame — the envelope the scenario just
 * delivered.
 */
async function lastFrame(client: HonestClient): Promise<Uint8Array> {
  const pages = await client.readKeyFrames();
  let last: Uint8Array | undefined;
  for (const body of pages) {
    for (const frame of splitKeyFrames(body)) last = frame;
  }
  if (!last) throw new Error('no-key-frame');
  return last;
}

export interface CollabWorldOptions {
  readonly dataDir?: string;
  readonly mode?: 'auto' | 'manual';
  readonly entropy?: Entropy;
  /** Device export JSON per name; generated live and recorded when omitted. */
  readonly devices?: Record<string, string>;
  readonly secret?: string;
  readonly seeds?: Record<string, string>;
  /** Deterministic wall clock; defaults to a per-world logical counter. */
  readonly now?: () => number;
}

export async function createCollabWorld(options: CollabWorldOptions = {}): Promise<CollabWorld> {
  let tick = 0;
  const dataDir = options.dataDir ?? tempDir('e2ee-collab-host-');
  const host = await launchLab(dataDir);
  const runtime = new LabRuntime({ mode: options.mode ?? 'auto' });
  const entropy = options.entropy ?? recordingEntropy();
  const devices: Record<string, DemoDevice> = {};
  const deviceExports: Record<string, string> = {};
  for (const name of [...MEMBERS, ...EXTRA_DEVICES]) {
    devices[name] = options.devices?.[name]
      ? await importDevice(options.devices[name])
      : await generateDevice();
    deviceExports[name] = await exportDevice(devices[name]);
  }
  const dirs: Record<string, string> = {};
  for (const name of [...MEMBERS, ...EXTRA_DEVICES]) {
    dirs[name] = tempDir(`e2ee-collab-${name}-`);
  }
  const world: CollabWorld = {
    host,
    dataDir,
    runtime,
    entropy,
    devices,
    deviceExports,
    dirs,
    clientDirs: [...MEMBERS, ...EXTRA_DEVICES].map((name) => dirs[name]!),
    members: {} as CollabWorld['members'],
    seeds: options.seeds ?? {
      crash: toHex(crypto.getRandomValues(new Uint8Array(16))),
    },
    secret: options.secret ?? `collab-secret-${toHex(crypto.getRandomValues(new Uint8Array(6)))}`,
    genesisHex: '',
    joins: {},
    hostFacade: undefined as unknown as LabBackend,
    now: options.now ?? (() => 1_700_000_000_000 + tick++),
  };
  world.hostFacade = {
    get baseUrl() {
      return world.host.baseUrl;
    },
    get riverrunUrl() {
      return world.host.riverrunUrl;
    },
    get riverrunDbPath() {
      return world.host.riverrunDbPath;
    },
    get dataDir() {
      return world.host.dataDir;
    },
    get port() {
      return world.host.port;
    },
    close: () => world.host.close(),
  };
  for (const name of MEMBERS) {
    world.members[name] = await labClient({
      host,
      account: name,
      runtime,
      entropy,
      device: deviceExports[name],
      clientDir: dirs[name]!,
      now: world.now,
    });
  }
  return world;
}

/** Connect a member client object onto the current host (after restart). */
async function reconnect(
  world: CollabWorld,
  name: (typeof MEMBERS)[number]
): Promise<HonestClient> {
  return labClient({
    host: world.host,
    account: name,
    runtime: world.runtime,
    entropy: world.entropy,
    device: world.deviceExports[name],
    clientDir: world.dirs[name],
    now: world.now,
  });
}

function step(name: string, run: (world: CollabWorld) => Promise<void>): CollabStep {
  return { name, run };
}

async function spawnCrashClient(
  world: CollabWorld,
  mode: 'write' | 'recover',
  marker: string
): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, join(here, '../test/crash-loro-client.ts')],
    {
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LAB_MODE: mode,
        LAB_BASE_URL: world.host.baseUrl,
        LAB_CLIENT_DIR: world.dirs['crash']!,
        LAB_MARKER: marker,
        LAB_TEXT: 'crash-mid',
        LAB_CRASH_AT: mode === 'write' ? 'after-cursor' : '',
        LAB_GENESIS: world.genesisHex,
        LAB_DEVICE: world.deviceExports['crash']!,
        LAB_SEED: world.seeds['crash']!,
        LAB_EPOCH_KEYS: JSON.stringify(
          Object.fromEntries(
            [...world.members.alice.epochKeys.entries()].map(([epoch, key]) => [
              String(epoch),
              toHex(key),
            ])
          )
        ),
      },
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  );
}

/**
 * The canonical multi-member collaboration script. Deterministic and
 * sequential: at most one honest operation is in flight, so the recorded
 * event order is a pure function of private material and attack actions.
 */
export function collabScript(): readonly CollabStep[] {
  return [
    step('alice-create-space', async (w) => {
      await w.members.alice.createSpace();
      w.genesisHex = w.members.alice.genesisHex!;
      await w.members.alice.readLedger();
    }),
    step('bob-request-join', async (w) => {
      w.joins['bob'] = await w.members.bob.requestJoin(w.genesisHex);
    }),
    step('alice-approve-bob', async (w) => {
      const approved = await w.members.alice.approveJoin(w.joins['bob']!);
      if (approved.status !== 'committed') throw new Error(`approve-bob:${approved.status}`);
    }),
    step('alice-deliver-epoch0-bob', async (w) => {
      await w.members.alice.deliverEpochKey(w.members.bob.device, 0);
    }),
    step('bob-receive-epoch0', async (w) => {
      await w.members.bob.readLedger();
      await w.members.bob.receiveEpochKey(
        w.members.alice.device,
        0,
        await lastFrame(w.members.bob)
      );
    }),
    step('alice-write-loro', async (w) => {
      await writeLoro(w.members.alice, `alice-online ${w.secret}`);
    }),
    step('bob-sync-loro', async (w) => {
      expectText(await readLoro(w.members.bob), 'alice-online');
    }),
    step('bob-write-loro', async (w) => {
      await writeLoro(w.members.bob, 'bob-edit');
    }),
    step('alice-sync-loro', async (w) => {
      expectText(await readLoro(w.members.alice), 'bob-edit');
    }),
    step('alice-write-flock', async (w) => {
      await writeFlock(w.members.alice, 'flock-note');
    }),
    step('bob-sync-flock', async (w) => {
      expectText(await readFlock(w.members.bob), 'flock-note');
    }),
    step('bob-offline-edit', async (w) => {
      const doc = w.members.bob.loroDoc;
      if (!doc) throw new Error('offline-no-doc');
      // The writer subscribes before the commit so the offline edit is
      // exported on reconnect; no network access happens in this step.
      w.offlineWriter = loroWriter(w.members.bob, doc);
      const text = doc.getText('text');
      text.insert(text.toString().length, ' bob-offline');
      doc.commit();
      persistLoroDocument(w.dirs['bob']!, doc);
    }),
    step('bob-reconnect', async (w) => {
      const writer = w.offlineWriter;
      if (!writer) throw new Error('offline-missing');
      await writer.createStream();
      const appended = await writer.appendWriteOnly();
      if (!appended.ok) throw new Error(`offline-append:${JSON.stringify(appended)}`);
      await writer.close();
      w.offlineWriter = undefined;
    }),
    step('alice-sync-offline', async (w) => {
      expectText(await readLoro(w.members.alice), 'bob-offline');
    }),
    step('carol-request-join', async (w) => {
      w.joins['carol'] = await w.members.carol.requestJoin(w.genesisHex);
    }),
    step('alice-approve-carol', async (w) => {
      const approved = await w.members.alice.approveJoin(w.joins['carol']!);
      if (approved.status !== 'committed') throw new Error(`approve-carol:${approved.status}`);
    }),
    step('alice-deliver-epoch0-carol', async (w) => {
      await w.members.alice.deliverEpochKey(w.members.carol.device, 0);
    }),
    step('carol-receive-epoch0', async (w) => {
      await w.members.carol.readLedger();
      await w.members.carol.receiveEpochKey(
        w.members.alice.device,
        0,
        await lastFrame(w.members.carol)
      );
    }),
    step('carol-sync-history', async (w) => {
      const text = await readLoro(w.members.carol);
      expectText(text, 'alice-online');
      expectText(text, 'bob-offline');
    }),
    step('carol-write-flock', async (w) => {
      await writeFlock(w.members.carol, 'carol-flock', ['private', 'carol']);
      expectText(await readFlock(w.members.alice, ['private', 'carol']), 'carol-flock');
    }),
    step('alice-admit-spare-lost-ack', async (w) => {
      // Scripted lost response: the CAS ack for the admit is dropped once, the
      // client keeps the exact pending bytes, and resume commits them.
      w.runtime.interceptWhen(
        (event) =>
          event.actor === 'alice' &&
          event.operation === 'submit' &&
          event.phase === 'request-queued',
        { kind: 'drop' }
      );
      const first = await w.members.alice.admitDevice(w.devices['spare']!, 'personal', false);
      if (first.status !== 'unknown') throw new Error(`lost-ack:${first.status}`);
      const resumed = await w.members.alice.resume();
      if (resumed.status !== 'committed') throw new Error(`resume-spare:${resumed.status}`);
      await w.members.alice.deliverEpochKey(w.devices['spare']!, 0);
    }),
    step('alice-revoke-spare', async (w) => {
      const revoked = await w.members.alice.revokeDevice(w.devices['spare']!.publicKey);
      if (revoked.status !== 'committed') throw new Error(`revoke-spare:${revoked.status}`);
    }),
    step('alice-publish-epoch', async (w) => {
      const published = await w.members.alice.publishEpoch();
      if (published.status !== 'committed' || published.epoch !== 1) {
        throw new Error(`publish-epoch:${published.status}:${published.epoch}`);
      }
    }),
    step('alice-deliver-epoch1-bob', async (w) => {
      await w.members.alice.deliverEpochKey(w.members.bob.device, 1);
    }),
    step('bob-receive-epoch1', async (w) => {
      await w.members.bob.readLedger();
      await w.members.bob.receiveEpochKey(
        w.members.alice.device,
        1,
        await lastFrame(w.members.bob)
      );
    }),
    step('alice-deliver-epoch1-carol', async (w) => {
      await w.members.alice.deliverEpochKey(w.members.carol.device, 1);
    }),
    step('carol-receive-epoch1', async (w) => {
      await w.members.carol.readLedger();
      await w.members.carol.receiveEpochKey(
        w.members.alice.device,
        1,
        await lastFrame(w.members.carol)
      );
    }),
    step('spare-epoch1-rejected', async (w) => {
      let rejected = false;
      try {
        await w.members.alice.deliverEpochKey(w.devices['spare']!, 1);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('revoked-device-received-epoch1');
    }),
    step('alice-write-epoch1', async (w) => {
      await writeLoro(w.members.alice, 'epoch-one');
    }),
    step('bob-sync-epoch1', async (w) => {
      const text = await readLoro(w.members.bob);
      expectText(text, 'epoch-one');
      expectText(text, 'alice-online');
    }),
    step('carol-sync-epoch1', async (w) => {
      expectText(await readLoro(w.members.carol), 'epoch-one');
    }),
    step('snapshot-upload', async (w) => {
      await uploadLoroSnapshot(w.members.alice, 'snap-checkpoint');
    }),
    step('dave-request-join', async (w) => {
      w.joins['dave'] = await w.members.dave.requestJoin(w.genesisHex);
    }),
    step('alice-approve-dave', async (w) => {
      const approved = await w.members.alice.approveJoin(w.joins['dave']!);
      if (approved.status !== 'committed') throw new Error(`approve-dave:${approved.status}`);
    }),
    step('alice-deliver-epoch1-dave', async (w) => {
      await w.members.alice.deliverEpochKey(w.members.dave.device, 1);
    }),
    step('dave-receive-keys', async (w) => {
      await w.members.dave.readLedger();
      await w.members.dave.receiveEpochKey(
        w.members.alice.device,
        1,
        await lastFrame(w.members.dave)
      );
      const history = await w.members.dave.recoverEpochHistory();
      if (!history.has(0) || !history.has(1)) throw new Error('dave-history-incomplete');
    }),
    step('dave-bootstrap', async (w) => {
      const boot = await bootstrapLoroFromSnapshot(w.members.dave, 'snap-checkpoint');
      expectText(boot.text, 'snap-checkpoint');
      expectText(await readLoro(w.members.dave), 'epoch-one');
    }),
    step('alice-admit-crash', async (w) => {
      const admitted = await w.members.alice.admitDevice(w.devices['crash']!, 'personal', false);
      if (admitted.status !== 'committed') throw new Error(`admit-crash:${admitted.status}`);
    }),
    step('crash-write', async (w) => {
      const marker = join(w.dirs['crash']!, 'crash.marker');
      const result = await spawnCrashClient(w, 'write', marker);
      if (result.signal !== 'SIGKILL') {
        throw new Error(`crash-write:${result.code}:${result.signal}:${result.stderr.slice(-200)}`);
      }
      if (readFileSync(marker, 'utf8') !== 'after-cursor') throw new Error('crash-marker-missing');
    }),
    step('crash-recover', async (w) => {
      const marker = join(w.dirs['crash']!, 'recover.marker');
      const result = await spawnCrashClient(w, 'recover', marker);
      if (result.code !== 0) {
        throw new Error(`crash-recover:${result.code}:${result.stderr.slice(-200)}`);
      }
      const recovered = JSON.parse(readFileSync(marker, 'utf8')) as { text?: string };
      expectText(recovered.text ?? '', 'crash-mid');
      expectText(recovered.text ?? '', 'epoch-one');
    }),
    step('host-restart', async (w) => {
      await w.host.close();
      w.host = await launchLab(w.dataDir);
      for (const name of MEMBERS) w.members[name].close();
    }),
    step('final-converge', async (w) => {
      for (const name of MEMBERS) {
        // Replace the stale member object so later measurement reads through
        // the restarted host, not the closed port.
        w.members[name] = await reconnect(w, name);
        await w.members[name].adoptGenesis(w.genesisHex);
        const text = await readLoro(w.members[name]);
        for (const marker of [
          'alice-online',
          'bob-edit',
          'bob-offline',
          'epoch-one',
          'crash-mid',
        ]) {
          expectText(text, marker);
        }
      }
    }),
  ];
}

/** Merge measured facts across honest clients; missing facts never pass. */
export function inspectClients(
  clients: readonly HonestClient[] | (() => readonly HonestClient[]),
  host: LabBackend
): () => Promise<HonestInspect> {
  return async () => {
    const list = typeof clients === 'function' ? clients() : clients;
    const live = list.filter((client) => client.genesisHex !== null);
    if (live.length === 0) return { unmeasured: true };
    const merged: HonestInspect = {
      verifiedRecords: 0,
      rejectedRecords: 0,
      unverifiedAccepted: 0,
      cursorAhead: false,
      durableLoss: false,
      importFailed: false,
    };
    for (const client of live) {
      const facts = await inspectClient(client, host)();
      if (facts.unmeasured) return { unmeasured: true };
      if (facts.verifiedRecords === undefined || facts.unverifiedAccepted === undefined) {
        return { unmeasured: true };
      }
      merged.verifiedRecords! += facts.verifiedRecords;
      merged.rejectedRecords! += facts.rejectedRecords ?? 0;
      merged.unverifiedAccepted! += facts.unverifiedAccepted;
      if (facts.cursorAhead === undefined) merged.cursorAhead = undefined;
      else if (merged.cursorAhead !== undefined) merged.cursorAhead ||= facts.cursorAhead;
      merged.durableLoss ||= facts.durableLoss === true;
      merged.importFailed ||= facts.importFailed === true;
    }
    return merged;
  };
}

export interface CollabRunOptions {
  readonly world: CollabWorld;
  readonly lab?: AttackLab;
  readonly agent?: CollabAgent;
  readonly script?: readonly CollabStep[];
  readonly maxTurnsPerStep?: number;
  readonly maxActions?: number;
}

function labFor(world: CollabWorld): AttackLab {
  return createAttackLab({
    host: world.hostFacade,
    runtime: world.runtime,
    clientDirs: world.clientDirs,
    expectedPlaintext: world.secret,
    genesisHex: () => world.genesisHex || null,
    inspectHonest: inspectClients(() => Object.values(world.members), world.hostFacade),
    // A full collab run plus model latency needs more than the 30s default.
    maxMs: 600_000,
  });
}

async function applyRecorded(
  lab: AttackLab,
  action: AttackAction,
  outcomes: CollabOutcome[]
): Promise<PublicReport | undefined> {
  try {
    return (await applyAttackAction(lab, action)) ?? undefined;
  } catch (error) {
    outcomes.push({ name: `attack:${action.op}`, error: String(error) });
    return undefined;
  }
}

/**
 * Run the collab script with an attacker acting at event boundaries. Each
 * step's promise starts first, so its first gate is already requested when
 * the agent gets a turn; every recorded action is marked with its step index
 * for model-free replay.
 */
export async function runCollabScenario(options: CollabRunOptions): Promise<CollabRun> {
  const { world } = options;
  const lab = options.lab ?? labFor(world);
  const script = options.script ?? collabScript();
  const maxTurns = options.maxTurnsPerStep ?? 3;
  const maxActions = options.maxActions ?? 64;
  const agent = options.agent;
  const marks: number[] = [];
  const outcomes: CollabOutcome[] = [];
  let report: PublicReport | undefined;
  let actionCount = 0;

  const markRecorded = (stepIndex: number, before: number): void => {
    const count = harnessReplayActions(lab).length;
    for (let index = before; index < count; index++) marks[index] = stepIndex;
  };

  const requestedCount = (): number =>
    world.runtime.events().filter((event) => event.status === 'requested').length;

  const agentTurns = async (
    stepIndex: number,
    stepName: string,
    pending: Promise<unknown>
  ): Promise<void> => {
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    for (let turn = 0; turn < maxTurns && !report && actionCount < maxActions; turn++) {
      if (settled || requestedCount() === 0) break;
      const before = harnessReplayActions(lab).length;
      const view = await lab.observe();
      let choice: AttackAction | readonly AttackAction[] | 'pass';
      try {
        choice = await agent!.act({
          step: stepIndex,
          stepName,
          turn,
          remainingSteps: script.slice(stepIndex).map((s) => s.name),
          view,
          readBackend: (input) => lab.readBackend(input),
        });
      } catch (error) {
        outcomes.push({ name: `agent:${stepName}`, error: String(error) });
        choice = 'pass';
      }
      if (choice === 'pass') {
        markRecorded(stepIndex, before);
        break;
      }
      for (const action of Array.isArray(choice) ? choice : [choice]) {
        actionCount += 1;
        // Drain while applying: actions like `finish` issue gated reads.
        report = (await drainUntil(world.runtime, applyRecorded(lab, action, outcomes))) ?? report;
      }
      markRecorded(stepIndex, before);
    }
  };

  const debug = Boolean(process.env.E2EE_SCENARIO_DEBUG);
  for (const [index, collabStep] of script.entries()) {
    if (debug) console.error(`[collab] step ${index} ${collabStep.name}`);
    const pending = collabStep.run(world);
    const outcome = pending.then(
      () => ({ name: collabStep.name }),
      (error) => ({ name: collabStep.name, error: String(error) })
    );
    // Surface the step's first boundary before the attacker gets a turn.
    await Promise.race([
      world.runtime.whenRequested(1),
      pending.then(
        () => undefined,
        () => undefined
      ),
    ]);
    if (agent) await agentTurns(index, collabStep.name, pending);
    outcomes.push(await drainUntil(world.runtime, outcome));
    if (debug) console.error(`[collab] done ${index} ${collabStep.name}`);
  }

  // Final boundary: the script converged; the attacker may still act before
  // the verdict is measured (e.g. a backend mutation or a claim).
  if (agent && !report) {
    for (let turn = 0; turn < maxTurns && !report && actionCount < maxActions; turn++) {
      const before = harnessReplayActions(lab).length;
      const view = await lab.observe();
      let choice: AttackAction | readonly AttackAction[] | 'pass';
      try {
        choice = await agent.act({
          step: script.length,
          stepName: 'finish-boundary',
          turn,
          remainingSteps: [],
          view,
          readBackend: (input) => lab.readBackend(input),
        });
      } catch (error) {
        outcomes.push({ name: 'agent:finish-boundary', error: String(error) });
        choice = 'pass';
      }
      if (choice === 'pass') {
        markRecorded(script.length, before);
        break;
      }
      for (const action of Array.isArray(choice) ? choice : [choice]) {
        actionCount += 1;
        report = (await drainUntil(world.runtime, applyRecorded(lab, action, outcomes))) ?? report;
      }
      markRecorded(script.length, before);
    }
  }

  if (!report) {
    const before = harnessReplayActions(lab).length;
    report = await drainUntil(world.runtime, lab.finish());
    markRecorded(script.length, before);
  }
  if (debug) console.error('[collab] finish measured');

  const base = await harnessReplayMaterial(lab);
  if (debug) console.error('[collab] material captured');
  const material: CollabMaterial = {
    version: 1,
    scenario: COLLAB_SCENARIO,
    secret: world.secret,
    genesisHex: world.genesisHex,
    devices: world.deviceExports,
    seeds: world.seeds,
    fills: isRecordingEntropy(world.entropy) ? [...world.entropy.fills] : [],
    marks,
    actions: base.actions,
    events: base.events,
    frames: base.frames,
    clients: base.clients,
    report,
  };
  return { outcomes, report, material, lab };
}

export interface CollabReplay {
  readonly outcomes: readonly CollabOutcome[];
  readonly report: PublicReport;
  readonly divergence: Divergence | null;
}

/**
 * Model-free replay: rebuild the world from identical private material, run
 * the same script, apply the recorded attack actions at the same step
 * boundaries, then compare events, frames, client digests and the verdict.
 */
export async function replayCollabScenario(material: CollabMaterial): Promise<CollabReplay> {
  const world = await createCollabWorld({
    mode: 'manual',
    entropy: replayEntropy(material.fills),
    devices: material.devices,
    secret: material.secret,
    seeds: material.seeds,
  });
  const lab = createAttackLab({
    host: world.hostFacade,
    runtime: world.runtime,
    clientDirs: world.clientDirs,
    expectedPlaintext: material.secret,
    genesisHex: material.genesisHex || null,
    inspectHonest: inspectClients(() => Object.values(world.members), world.hostFacade),
    maxMs: 600_000,
  });
  const script = collabScript();
  const byStep = new Map<number, AttackAction[]>();
  material.actions.forEach((action, index) => {
    const stepIndex = material.marks[index] ?? script.length;
    const list = byStep.get(stepIndex) ?? [];
    list.push(action);
    byStep.set(stepIndex, list);
  });
  const outcomes: CollabOutcome[] = [];
  let report: PublicReport | undefined;
  const debug = Boolean(process.env.E2EE_SCENARIO_DEBUG);
  for (const [index, collabStep] of script.entries()) {
    if (debug) console.error(`[collab-replay] step ${index} ${collabStep.name}`);
    const pending = collabStep.run(world);
    const outcome = pending.then(
      () => ({ name: collabStep.name }),
      (error) => ({ name: collabStep.name, error: String(error) })
    );
    await Promise.race([
      world.runtime.whenRequested(1),
      pending.then(
        () => undefined,
        () => undefined
      ),
    ]);
    for (const action of byStep.get(index) ?? []) {
      report = (await drainUntil(world.runtime, applyRecorded(lab, action, outcomes))) ?? report;
    }
    outcomes.push(await drainUntil(world.runtime, outcome));
    if (debug) console.error(`[collab-replay] done ${index} ${collabStep.name}`);
  }
  for (const action of byStep.get(script.length) ?? []) {
    report = (await drainUntil(world.runtime, applyRecorded(lab, action, outcomes))) ?? report;
  }
  if (!report) report = await drainUntil(world.runtime, lab.finish());
  const actual = await harnessReplayMaterial(lab);
  const divergence = firstCollabDivergence(material, {
    events: actual.events,
    frames: actual.frames,
    clients: actual.clients,
    report,
  });
  return { outcomes, report, divergence };
}

export function firstCollabDivergence(
  expected: Pick<CollabMaterial, 'events' | 'frames' | 'clients' | 'report'>,
  actual: {
    events: readonly LabEvent[];
    frames: readonly ProtocolFrame[];
    clients: readonly ClientDigest[];
    report: PublicReport;
  }
): Divergence | null {
  const divergence = firstReplayDivergence(
    { events: expected.events, frames: expected.frames, entropy: [] },
    { events: actual.events, frames: actual.frames, entropy: [] }
  );
  if (divergence) return divergence;
  const count = Math.max(expected.clients.length, actual.clients.length);
  for (let index = 0; index < count; index++) {
    const left = expected.clients[index];
    const right = actual.clients[index];
    if (!left || !right) {
      return {
        index,
        field: 'client',
        expected: left ? 'present' : 'missing',
        actual: right ? 'present' : 'missing',
      };
    }
    for (const key of [
      'ledgerRecords',
      'ledgerHead',
      'loroDoc',
      'flockDoc',
      'loroCursor',
      'flockCursor',
    ] as const) {
      if (left[key] !== right[key]) {
        return {
          index,
          field: `client.${key}`,
          expected: String(left[key]),
          actual: String(right[key]),
        };
      }
    }
  }
  for (const field of ['confidentiality', 'integrity', 'durability', 'detectability'] as const) {
    if (expected.report[field] !== actual.report[field]) {
      return {
        index: 0,
        field: `verdict.${field}`,
        expected: String(expected.report[field]),
        actual: String(actual.report[field]),
      };
    }
  }
  return null;
}
