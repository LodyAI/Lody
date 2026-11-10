// Explicit maintenance command; native builds consume the generated local file.
// Usage: node --experimental-strip-types scripts/provider-catalog.mjs /path/to/packages/shared/src/acp/registry-generated.ts
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { format } from 'prettier';
if (!process.argv[2])
  throw new Error('Pass the reviewed public registry-generated.ts source');
const source = resolve(process.argv[2]);
const { REGISTRY_ACP_AGENTS } = await import(pathToFileURL(source));
const hash = createHash('sha256')
  .update(await readFile(source))
  .digest('hex');
const entries = REGISTRY_ACP_AGENTS.map(({ id, name }) => ({
  id: `registry:${id}`,
  name,
  cliType: 'registry',
  agentType: id,
}));
await writeFile(
  new URL('../src/protocol/provider-catalog.ts', import.meta.url),
  await format(
    `// Generated from packages/shared/src/acp/registry-generated.ts.\n// Source SHA256: ${hash}\n// Regenerate explicitly with scripts/provider-catalog.mjs; no native build reads the root workspace.\nexport const registryProviderCatalog = ${JSON.stringify(entries, null, 2)};\n`,
    { parser: 'typescript', singleQuote: true, trailingComma: 'all' },
  ),
);
