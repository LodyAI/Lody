import { test, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPlugin, inspectProposalPackage, installPackage } from './plugin-package';

test('deterministic releases include only declared files; integrity and approval failures publish no generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'package-release-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    generations = join(root, 'generations');
  await mkdir(source);
  await writeFile(
    join(source, 'lody.plugin.json'),
    JSON.stringify({
      id: 'demo',
      version: '1.0.0',
      sdk: '^1.0.0',
      title: 'Demo',
      client: 'main.ts',
    })
  );
  await writeFile(join(source, 'main.ts'), 'export default 123');
  const a = await packPlugin(source, join(root, 'a'));
  await writeFile(join(source, '.env'), 'MUST_NOT_SHIP');
  const b = await packPlugin(source, join(root, 'b'));
  expect(b.sha256).toBe(a.sha256);
  const bytes = await readFile(a.path);
  expect(bytes.includes('MUST_NOT_SHIP')).toBe(false);
  const info = await inspectProposalPackage(a.path);
  const current = await installPackage(a.path, generations, info.sha256);
  expect(await readFile(join(current.directory, 'client.js'), 'utf8')).toContain('123');
  await expect(installPackage(b.path, generations, '0'.repeat(64))).rejects.toThrow(/changed/);
  for (const malformed of [
    Buffer.concat([bytes, Buffer.from('x')]),
    bytes.subarray(0, -1),
    Buffer.from(bytes.toString('latin1').replace('client.js', '../bad.js'), 'latin1'),
    Buffer.from(bytes.toString('latin1').replace('123', '456'), 'latin1'),
  ]) {
    await writeFile(b.path, malformed);
    await expect(inspectProposalPackage(b.path)).rejects.toThrow();
    await expect(installPackage(b.path, generations)).rejects.toThrow();
  }
  expect(await readdir(generations)).toHaveLength(1);
});
