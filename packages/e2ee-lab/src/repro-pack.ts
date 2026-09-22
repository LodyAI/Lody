import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntropyFill } from './entropy';
import { replayEntropy, isReplayEntropy } from './entropy';
import type { FailureFingerprint } from './fingerprint';
import { fingerprintsEqual } from './fingerprint';
import {
  assertReplayEnvironment,
  captureImplementationIdentity,
  REPRO_FORMAT,
  REPRO_SCENARIO_COLLAB,
  REPRO_SCENARIO_DEFECT,
  type ImplementationIdentity,
} from './identity';
import type { ScheduleChoice } from './schedule';
import type { KnownDefect } from './defects';
import { applyKnownDefect, measureClient } from './defects';
import { labClient, launchLab } from './fixtures';
import type { Divergence } from './replay';
import type { AttackAction } from './attack-lab';
import type { CollabMaterial } from './scenario';

export type ReproScope = 'full-execution' | 'transport-checkpoint';

export interface ReproManifest {
  readonly format: typeof REPRO_FORMAT;
  readonly scenario: string;
  readonly scenarioVersion: string;
  readonly scope: ReproScope;
  readonly identity: ImplementationIdentity;
  readonly environment: { readonly node: string };
  readonly expected: FailureFingerprint;
  readonly defect?: KnownDefect;
  readonly genesisHex?: string;
}

export interface ReproPrivate {
  readonly devices: Record<string, string>;
  readonly fills: readonly EntropyFill[];
  readonly secret?: string;
  readonly seeds?: Record<string, string>;
  readonly foreignDevice?: string;
  readonly schedule?: readonly ScheduleChoice[];
  readonly actions?: readonly AttackAction[];
  readonly collab?: CollabMaterial;
}

export interface ReproPack {
  readonly manifest: ReproManifest;
  readonly private: ReproPrivate;
}

export interface ReproReplay {
  readonly fingerprint: FailureFingerprint;
  readonly divergence: Divergence | null;
  readonly scope: ReproScope;
}

function encodeFills(fills: readonly EntropyFill[]): unknown {
  return fills.map((fill) => ({
    label: fill.label,
    bytes: Buffer.from(fill.bytes).toString('base64'),
  }));
}

function decodeFills(value: unknown): EntropyFill[] {
  if (!Array.isArray(value)) throw new Error('repro-invalid-entropy');
  return value.map((row) => {
    const record = row as { label?: unknown; bytes?: unknown };
    if (typeof record.label !== 'string' || typeof record.bytes !== 'string') {
      throw new Error('repro-invalid-entropy');
    }
    return { label: record.label, bytes: new Uint8Array(Buffer.from(record.bytes, 'base64')) };
  });
}

function reviveFills(material: CollabMaterial): CollabMaterial {
  return {
    ...material,
    fills: decodeFills(encodeFills(material.fills)),
  };
}

export function writeReproPack(dir: string, pack: ReproPack): void {
  mkdirSync(dir, { recursive: true });
  const privateDir = join(dir, 'private');
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(pack.manifest, null, 2)}\n`);
  const privateBody = {
    devices: pack.private.devices,
    fills: encodeFills(pack.private.fills),
    secret: pack.private.secret,
    seeds: pack.private.seeds,
    foreignDevice: pack.private.foreignDevice,
    schedule: pack.private.schedule,
    actions: pack.private.actions,
    collab: pack.private.collab
      ? { ...pack.private.collab, fills: encodeFills(pack.private.collab.fills) }
      : undefined,
  };
  writeFileSync(join(privateDir, 'bundle.json'), `${JSON.stringify(privateBody)}\n`);
  chmodSync(privateDir, 0o700);
  chmodSync(join(privateDir, 'bundle.json'), 0o600);
}

export function loadReproPack(dir: string): ReproPack {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReproManifest;
  if (manifest.format !== REPRO_FORMAT) {
    throw new Error(`repro-unsupported-format:${String(manifest.format)}`);
  }
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'private/bundle.json'), 'utf8');
  } catch {
    throw new Error('repro-missing-private');
  }
  const body = JSON.parse(raw) as {
    devices?: Record<string, string>;
    fills?: unknown;
    secret?: string;
    seeds?: Record<string, string>;
    foreignDevice?: string;
    schedule?: ScheduleChoice[];
    actions?: AttackAction[];
    collab?: CollabMaterial & { fills: unknown };
  };
  if (!body.devices) throw new Error('repro-missing-devices');
  const collab = body.collab
    ? reviveFills({ ...body.collab, fills: decodeFills(body.collab.fills) })
    : undefined;
  return {
    manifest,
    private: {
      devices: body.devices,
      fills: decodeFills(body.fills ?? []),
      secret: body.secret,
      seeds: body.seeds,
      foreignDevice: body.foreignDevice,
      schedule: body.schedule,
      actions: body.actions,
      collab,
    },
  };
}

export function createDefectPack(input: {
  defect: KnownDefect;
  devices: Record<string, string>;
  fills: readonly EntropyFill[];
  expected: FailureFingerprint;
  genesisHex: string;
  foreignDevice?: string;
  secret?: string;
}): ReproPack {
  return {
    manifest: {
      format: REPRO_FORMAT,
      scenario: REPRO_SCENARIO_DEFECT,
      scenarioVersion: input.defect,
      scope: 'full-execution',
      identity: captureImplementationIdentity(),
      environment: { node: process.version },
      expected: input.expected,
      defect: input.defect,
      genesisHex: input.genesisHex,
    },
    private: {
      devices: input.devices,
      fills: input.fills,
      foreignDevice: input.foreignDevice,
      secret: input.secret,
    },
  };
}

export function createCollabPack(
  material: CollabMaterial,
  expected: FailureFingerprint
): ReproPack {
  return {
    manifest: {
      format: REPRO_FORMAT,
      scenario: REPRO_SCENARIO_COLLAB,
      scenarioVersion: material.scenario,
      scope: 'full-execution',
      identity: captureImplementationIdentity(),
      environment: { node: process.version },
      expected,
      genesisHex: material.genesisHex,
    },
    private: {
      devices: material.devices,
      fills: material.fills,
      secret: material.secret,
      seeds: material.seeds,
      schedule: material.schedule,
      actions: material.actions,
      collab: material,
    },
  };
}

async function replayDefectPack(pack: ReproPack): Promise<ReproReplay> {
  const defect = pack.manifest.defect;
  if (!defect) throw new Error('repro-missing-defect');
  const entropy = replayEntropy(pack.private.fills);
  const host = await launchLab();
  const alice = await labClient({
    host,
    account: 'alice',
    entropy,
    device: pack.private.devices.alice,
  });
  await alice.createSpace();
  await alice.readLedger();
  let foreignDir: string | undefined;
  if (defect === 'wrong-context-journal') {
    const other = await labClient({
      host,
      account: 'other',
      entropy,
      device: pack.private.foreignDevice ?? pack.private.devices.other,
    });
    await other.createSpace();
    await other.readLedger();
    foreignDir = other.clientDir;
  }
  await applyKnownDefect(defect, {
    clientDir: alice.clientDir,
    genesisHex: alice.genesisHex!,
    foreignDir,
  });
  const measured = await measureClient(alice, host);
  if (isReplayEntropy(entropy) && entropy.remaining().length > 0) {
    return {
      fingerprint: measured.fingerprint,
      divergence: {
        index: entropy.consumed(),
        field: 'entropy.tail',
        expected: 'consumed',
        actual: entropy.remaining()[0]!.label,
      },
      scope: pack.manifest.scope,
    };
  }
  const divergence = fingerprintsEqual(pack.manifest.expected, measured.fingerprint)
    ? null
    : {
        index: 0,
        field: 'fingerprint.rules',
        expected: pack.manifest.expected.rules.join(','),
        actual: measured.fingerprint.rules.join(','),
      };
  return { fingerprint: measured.fingerprint, divergence, scope: pack.manifest.scope };
}

export async function replayReproPack(dir: string): Promise<ReproReplay> {
  const pack = loadReproPack(dir);
  assertReplayEnvironment(pack.manifest.identity);
  if (pack.manifest.scope !== 'full-execution' && pack.manifest.scope !== 'transport-checkpoint') {
    throw new Error(`repro-unsupported-scope:${pack.manifest.scope}`);
  }
  if (pack.manifest.scope === 'transport-checkpoint') {
    throw new Error('repro-transport-checkpoint-unimplemented');
  }
  if (pack.manifest.scenario === REPRO_SCENARIO_DEFECT) {
    return replayDefectPack(pack);
  }
  if (pack.manifest.scenario === REPRO_SCENARIO_COLLAB) {
    if (!pack.private.collab) throw new Error('repro-missing-collab');
    const { replayCollabScenario } = await import('./scenario');
    const replay = await replayCollabScenario(pack.private.collab);
    const fingerprint = pack.manifest.expected;
    const divergence =
      replay.divergence ??
      (replay.report.integrity === fingerprint.integrity &&
      replay.report.durability === fingerprint.durability
        ? null
        : {
            index: 0,
            field: 'fingerprint.verdict',
            expected: fingerprint.integrity,
            actual: replay.report.integrity,
          });
    return { fingerprint, divergence, scope: pack.manifest.scope };
  }
  throw new Error(`repro-unsupported-scenario:${pack.manifest.scenario}`);
}
