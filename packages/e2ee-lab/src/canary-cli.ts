import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Schema } from 'effect';
import { scanE2eeCanaries } from './pure/canary';
const Manifest = Schema.Struct({
  canaries: Schema.Struct({
    message: Schema.String,
    title: Schema.String,
    fileName: Schema.String,
    mcpEnvironment: Schema.String,
    machineConfig: Schema.String,
  }),
  sources: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['streams', 'http']),
      id: Schema.String,
      path: Schema.String,
    })
  ),
});
try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3 || !isAbsolute(path)) throw new Error('canary_usage');
  const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(path, 'utf8')));
  let bytes = 0;
  const sources = manifest.sources.map((source) => {
    if (!isAbsolute(source.path)) throw new Error('canary_source_not_absolute');
    bytes += statSync(source.path).size;
    if (bytes > 256 * 1024 * 1024) throw new Error('canary_observation_budget');
    return { ...source, body: new Uint8Array(readFileSync(source.path)) };
  });
  const report = scanE2eeCanaries(manifest.canaries, sources);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 2;
} catch {
  process.stderr.write(
    'canary_invalid_input: provide an absolute synthetic manifest with bounded Streams and HTTP body files\n'
  );
  process.exitCode = 64;
}
