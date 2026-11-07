import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { z } from 'zod/v4';
import {
  Envelope,
  PROTOCOL_VERSION,
  RuntimeError,
} from '../src/contract/envelope.ts';
import {
  hostCalls,
  runtimeCalls,
  runtimeEvents,
} from '../src/contract/methods.ts';
import { emitSwift } from './contract-swift.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const schemaPath =
  root + 'packages/cloud-runtime/contract/runtime-contract.json';
const swiftPath =
  root +
  'packages/lody-core/Sources/LodyCore/Contract/RuntimeContract.generated.swift';

const contractDir = new URL('../src/contract/', import.meta.url);
const exported = [];
for (const file of (await readdir(contractDir))
  .filter((name) => name.endsWith('.ts'))
  .sort())
  for (const value of Object.values(await import(new URL(file, contractDir))))
    if (value?._zod && z.globalRegistry.get(value)?.id) exported.push(value);

function schemaId(schema, where) {
  const id = z.globalRegistry.get(schema)?.id;
  if (!id) throw new Error(`${where} needs .meta({ id })`);
  return id;
}

function buildContract() {
  const registry = z.registry();
  const named = (schema, where) => {
    const id = schemaId(schema, where);
    if (!registry.has(schema)) registry.add(schema, { id });
    return id;
  };
  named(RuntimeError, 'RuntimeError');
  for (const schema of exported) named(schema, 'export');
  const calls = (table, label) =>
    Object.fromEntries(
      Object.entries(table)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([method, spec]) => [
          method,
          {
            params: named(spec.params, `${label}.${method}.params`),
            result: named(spec.result, `${label}.${method}.result`),
            timeoutMs: spec.timeoutMs,
          },
        ]),
    );
  const contract = {
    protocol: PROTOCOL_VERSION,
    runtimeCalls: calls(runtimeCalls, 'runtimeCalls'),
    hostCalls: calls(hostCalls, 'hostCalls'),
    events: Object.fromEntries(
      Object.entries(runtimeEvents)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([method, schema]) => [
          method,
          named(schema, `runtimeEvents.${method}`),
        ]),
    ),
  };
  const options = { target: 'draft-2020-12', uri: (id) => id };
  const { schemas } = z.toJSONSchema(registry, { ...options, io: 'input' });
  const output = z.toJSONSchema(registry, { ...options, io: 'output' }).schemas;
  for (const [id, schema] of Object.entries(schemas))
    if (schema.$defs)
      throw new Error(
        `${id} nests named schemas that are not exported from src/contract: ${Object.keys(schema.$defs).join(', ')}`,
      );
  const shape = (schema) =>
    JSON.stringify(schema, (key, value) =>
      key === 'additionalProperties' && value === false ? undefined : value,
    );
  for (const [id, schema] of Object.entries(schemas))
    if (shape(schema) !== shape(output[id]))
      throw new Error(
        `${id}: input and output shapes differ (transform or default); the wire carries one shape`,
      );
  const { $schema, ...envelope } = z.toJSONSchema(Envelope, {
    target: 'draft-2020-12',
    io: 'input',
  });
  contract.envelope = envelope;
  contract.types = Object.fromEntries(
    Object.entries(schemas)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { $schema, $id, id, ...schema }]) => [key, schema]),
  );
  return contract;
}

const contract = buildContract();
const json = await prettier.format(JSON.stringify(contract), {
  ...(await prettier.resolveConfig(schemaPath)),
  filepath: schemaPath,
});
const swift = emitSwift(contract);

if (process.argv.includes('--check')) {
  const stale = [];
  for (const [path, text] of [
    [schemaPath, json],
    [swiftPath, swift],
  ]) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current !== text) stale.push(path.slice(root.length));
  }
  if (stale.length) {
    console.error(
      `Runtime contract is stale: ${stale.join(', ')}\nRun pnpm contract.`,
    );
    process.exit(1);
  }
} else {
  await writeFile(schemaPath, json);
  await writeFile(swiftPath, swift);
}
