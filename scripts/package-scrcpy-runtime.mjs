#!/usr/bin/env node
// Prepare the verified public artifact; publishing is an external release operation.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw Error(
    'Usage: node scripts/package-scrcpy-runtime.mjs <scrcpy-server-v3.3.3> <output-directory>'
  );
const bytes = await readFile(resolve(source));
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (
  bytes.length !== 90164 ||
  sha256 !== '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0'
)
  throw Error('scrcpy server integrity check failed');
const output = resolve(destination);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'scrcpy-server-v3.3.3'), bytes);
const notices = JSON.parse(
  await readFile(
    new URL('../apps/cli/src/android-emulator/scrcpy-notices.json', import.meta.url),
    'utf8'
  )
);
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.text);
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      version: '3.3.3',
      platform: 'universal',
      size: bytes.length,
      sha256,
      path: '/api/runtimes/scrcpy/3.3.3/universal/scrcpy-server-v3.3.3',
    },
    null,
    2
  ) + '\n'
);
