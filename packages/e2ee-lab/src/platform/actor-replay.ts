import { openSqliteConnection } from '@lody/e2ee-core/internal';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
export interface LabOriginalRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyHex: string;
}
export interface LabPreparedInputs {
  outbox: readonly { slot: string; frameHex: string }[];
  rotation?: Record<string, string | number | null>;
}
export interface LabOriginalLocalEdit {
  model: 'loro' | 'flock';
  text: string;
  deltaHex: string;
}
export interface LabActorReplayRow {
  index: number;
  operation: string;
  requests: LabOriginalRequest[];
  prepared: LabPreparedInputs;
  localEdits: LabOriginalLocalEdit[];
}
/** Only immutable PRE-DISPATCH inputs: delivery frames and an unsettled candidate.
 * No installed keys, native documents/cursors, results or terminal task state. */
export function capturePreparedInputs(directory: string, actor: string): LabPreparedInputs {
  const outboxPath = join(directory, `${actor}-outbox.sqlite`),
    rotationPath = join(directory, `${actor}-rotation.sqlite`);
  const outbox: { slot: string; frameHex: string }[] = [];
  let rotation: LabPreparedInputs['rotation'];
  if (existsSync(outboxPath)) {
    const db = openSqliteConnection(outboxPath, { readonly: true, fileMustExist: true });
    try {
      for (const row of db.prepare('SELECT slot,frame FROM epoch_delivery').all() as {
        slot: string;
        frame: Uint8Array;
      }[])
        outbox.push({ slot: row.slot, frameHex: Buffer.from(row.frame).toString('hex') });
    } finally {
      db.close();
    }
  }
  if (existsSync(rotationPath)) {
    const db = openSqliteConnection(rotationPath, { readonly: true, fileMustExist: true });
    try {
      const candidate = db
        .prepare('SELECT * FROM epoch_rotation_candidates WHERE outcome IS NULL AND consumed=0')
        .get() as Record<string, unknown> | undefined;
      if (candidate) {
        rotation = {};
        for (const [name, value] of Object.entries(candidate)) {
          if (value instanceof Uint8Array) rotation[name] = Buffer.from(value).toString('hex');
          else if (value === null || typeof value === 'number' || typeof value === 'string')
            rotation[name] = value;
          else throw new Error('invalid-prepared-input');
        }
      }
    } finally {
      db.close();
    }
  }
  return { outbox, rotation };
}
/** Restore original INPUT rows into their current native owner. Existing rows
 * must match exactly; this never overwrites state or selects ledger authority. */
export function seedPreparedInputs(directory: string, actor: string, prepared: LabPreparedInputs) {
  if (prepared.outbox.length) {
    const db = openSqliteConnection(join(directory, `${actor}-outbox.sqlite`), {
      fileMustExist: true,
    });
    try {
      db.transaction(() => {
        for (const row of prepared.outbox) {
          if (!/^(?:[0-9a-f]{2}){1,512}$/.test(row.frameHex))
            throw new Error('invalid-prepared-input');
          const bytes = Buffer.from(row.frameHex, 'hex'),
            prior = db.prepare('SELECT frame FROM epoch_delivery WHERE slot=?').get(row.slot) as
              | { frame: Uint8Array }
              | undefined;
          if (prior && !Buffer.from(prior.frame).equals(bytes))
            throw new Error('prepared-input-conflict');
          db.prepare('INSERT OR IGNORE INTO epoch_delivery VALUES(?,?)').run(row.slot, bytes);
        }
      })();
    } finally {
      db.close();
    }
  }
  if (prepared.rotation) {
    const row = prepared.rotation;
    if (row.outcome !== null || row.consumed !== 0 || row.binding !== null)
      throw new Error('invalid-prepared-input');
    const names = [
      'id',
      'parent',
      'parent_count',
      'epoch',
      'commitment',
      'record',
      'envelopes',
      'blob',
      'outcome',
      'binding',
      'consumed',
    ];
    if (Object.keys(row).some((name) => !names.includes(name)))
      throw new Error('invalid-prepared-input');
    const blobNames = ['parent', 'commitment', 'record', 'envelopes', 'blob'];
    const values = names.map((name) =>
      blobNames.includes(name) ? Buffer.from(String(row[name]), 'hex') : row[name]
    );
    const db = openSqliteConnection(join(directory, `${actor}-rotation.sqlite`), {
      fileMustExist: true,
    });
    try {
      const prior = db
        .prepare('SELECT record FROM epoch_rotation_candidates WHERE id=?')
        .get(row.id) as { record: Uint8Array } | undefined;
      if (prior && !Buffer.from(prior.record).equals(Buffer.from(String(row.record), 'hex')))
        throw new Error('prepared-input-conflict');
      db.prepare(
        `INSERT OR IGNORE INTO epoch_rotation_candidates(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`
      ).run(...values);
    } finally {
      db.close();
    }
  }
}
export function saveActorReplay(input: {
  privateDirectory: string;
  actor: string;
  row: LabActorReplayRow;
}) {
  const path = join(input.privateDirectory, `${input.actor}-actions.jsonl`),
    text = JSON.stringify(input.row) + '\n';
  if ((existsSync(path) ? statSync(path).size : 0) + Buffer.byteLength(text) > 64 * 1024 * 1024)
    throw new Error('private-replay-budget');
  appendFileSync(path, text, { mode: 0o600 });
}
export function loadActorReplay(
  directory: string,
  actor: string,
  index: number,
  operation: string
): LabActorReplayRow {
  const path = join(directory, `${actor}-actions.jsonl`);
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('private-replay-budget');
  const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as LabActorReplayRow),
    row = rows.find((item) => item.index === index);
  if (
    !row ||
    row.operation !== operation ||
    !Array.isArray(row.requests) ||
    !row.prepared ||
    !Array.isArray(row.localEdits)
  )
    throw new Error('private-replay-missing-action');
  return row;
}
