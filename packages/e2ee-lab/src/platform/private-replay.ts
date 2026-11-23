import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { LabActorConfiguration } from '../pure/actor-config';
export const PrivateReplayMaterial = Schema.Struct({
  format: Schema.Literal('lody-lab-private-replay/v1'),
  syntheticOnly: Schema.Literal(true),
  actors: Schema.Array(LabActorConfiguration),
  devices: Schema.Record(Schema.String, Schema.String),
  initialRecords: Schema.Array(Schema.String),
});
export type PrivateReplayMaterial = typeof PrivateReplayMaterial.Type;
export const replayDigest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function savePrivateReplay(directory: string, material: PrivateReplayMaterial) {
  mkdirSync(directory, { mode: 0o700 });
  const text = JSON.stringify(Schema.decodeUnknownSync(PrivateReplayMaterial)(material));
  writeFileSync(join(directory, 'material.json'), text, { mode: 0o600, flag: 'wx' });
  return { format: material.format, sha256: replayDigest(text) };
}
export function loadPrivateReplay(directory: string, expectedHash: string) {
  const path = join(directory, 'material.json'),
    info = statSync(path);
  if ((info.mode & 0o777) !== 0o600 || !info.isFile() || info.size > 1024 * 1024)
    throw new Error('private-replay-file');
  const text = readFileSync(path, 'utf8');
  if (replayDigest(text) !== expectedHash) throw new Error('private-replay-binding');
  return Schema.decodeUnknownSync(PrivateReplayMaterial)(JSON.parse(text));
}
