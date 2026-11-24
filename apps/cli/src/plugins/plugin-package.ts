import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { gzipSync, gunzipSync } from 'node:zlib';
import { create, Parser, Header } from 'tar';
import { pluginCapabilities } from '@lody/shared/plugins/capabilities';
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema';
import { computeClientDigest } from '@lody/shared/plugins/digest';
import type { PluginBuild } from './workflow/dev-plugin-compiler';

const integrity = 'lody.integrity.json';
const limit = 32 * 1024 * 1024;
const index = z
  .array(
    z.strictObject({
      path: z.string().max(512),
      size: z.number().int().nonnegative().max(limit),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
  )
  .min(1)
  .max(1024);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function paths(m: PluginManifest) {
  return [
    ...new Set([
      'lody.plugin.json',
      'package.json',
      ...(m.machine ? [m.machine] : []),
      ...(m.client ? [m.client] : []),
      ...(m.assets ?? []),
      ...(m.styles ?? []),
      ...(m.skills ?? []).map((s) => `skills/${s}/SKILL.md`),
      ...(m.themes ?? []).flatMap((t) => ('path' in t ? [t.path] : [])),
      ...(m.agentRoles ?? []).map((r) => r.promptPath),
      ...(m.mcpServers ?? []).map((r) => r.entry),
    ]),
  ].sort();
}
function portable(p: string) {
  return p
    .split('/')
    .every(
      (s) =>
        /^[a-zA-Z0-9_.@ -]+$/.test(s) &&
        !s.endsWith('.') &&
        !s.endsWith(' ') &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)
    );
}
async function bounded(path: string, max: number) {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > max) throw Error('Invalid package file size or type');
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await fd.read(buf, offset, buf.length - offset, offset);
      if (!bytesRead) throw Error('Truncated package');
      offset += bytesRead;
    }
    return buf;
  } finally {
    await fd.close();
  }
}
const json = (bytes: Buffer) => JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
async function verify(bytes: Buffer) {
  const tar = gunzipSync(bytes, { maxOutputLength: limit });
  if (!new Header(tar).cksumValid) throw Error('Invalid npm tarball');
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        const name = entry.path.slice('package/'.length);
        if (
          entry.type !== 'File' ||
          !entry.path.startsWith('package/') ||
          !portable(name) ||
          seen.has(name.toLowerCase()) ||
          seen.size >= 1025
        )
          throw Error('Invalid package entry');
        seen.add(name.toLowerCase());
        const parts: Buffer[] = [];
        entry.on('data', (part) => parts.push(part));
        entry.once('end', () => files.set(name, Buffer.concat(parts)));
        entry.resume();
      },
    });
    parser.once('error', reject).once('end', resolve).end(tar);
  });
  const header = files.get(integrity);
  if (!header || header.length > 256 * 1024) throw Error('Invalid integrity manifest');
  files.delete(integrity);
  const entries = index.parse(json(header));
  const listed = new Set<string>();
  for (const entry of entries) {
    const body = files.get(entry.path);
    if (
      !body ||
      listed.has(entry.path) ||
      body.length !== entry.size ||
      hash(body) !== entry.sha256
    )
      throw Error('Package integrity mismatch');
    listed.add(entry.path);
  }
  if (files.size !== listed.size) throw Error('Unlisted package entry');
  for (const p of seen) {
    let dir = dirname(p);
    while (dir !== '.') {
      if (seen.has(dir)) throw Error('Conflicting package paths');
      dir = dirname(dir);
    }
  }
  const manifest = pluginManifestSchema.parse(
    json(files.get('lody.plugin.json') ?? Buffer.alloc(0))
  );
  const expected = paths(manifest);
  if (
    expected.length !== files.size ||
    !expected.every((p) => files.has(p)) ||
    !z
      .strictObject({
        name: z.literal(manifest.id),
        version: z.literal(manifest.version),
        type: z.literal('module'),
      })
      .safeParse(json(files.get('package.json')!)).success ||
    (manifest.client && manifest.client !== 'client.js') ||
    (manifest.machine && manifest.machine !== 'machine.js')
  )
    throw Error('Package contents do not match manifest');
  return { files, manifest };
}
export async function packPlugin(sourceDir: string, destination: string) {
  const stage = await mkdtemp(join(tmpdir(), 'lody-pack-'));
  try {
    const { compilePlugin } = await import('./plugin-build');
    const { manifest } = await compilePlugin({ sourceDir, stage });
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify({ name: manifest.id, version: manifest.version, type: 'module' })
    );
    const entries = [];
    let total = 0;
    const names = paths(manifest);
    for (const path of names) {
      if (!portable(path) || path.toLowerCase() === integrity) throw Error('Invalid package path');
      const bytes = await bounded(join(stage, path), limit - total);
      total += bytes.length;
      entries.push({ path, size: bytes.length, sha256: hash(bytes) });
    }
    await writeFile(join(stage, integrity), JSON.stringify(entries), { flag: 'wx' });
    const stream = create({ cwd: stage, prefix: 'package', portable: true, noMtime: true }, [
      ...names,
      integrity,
    ]);
    const archive = gzipSync(await stream.concat());
    await verify(archive);
    await writeFile(destination, archive, { flag: 'wx', mode: 0o600 });
    return { path: destination, sha256: hash(archive) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function installPackage(
  path: string,
  root: string,
  expectedSha256?: string
): Promise<PluginBuild> {
  const bytes = await bounded(path, limit);
  if (expectedSha256 !== undefined && hash(bytes) !== expectedSha256)
    throw Error('Plugin package changed');
  const { manifest, files } = await verify(bytes);
  const clientDigest = await computeClientDigest(manifest, async (p) => files.get(p)!);
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(join(root, '.stage-'));
  try {
    for (const [name, bytes] of files) {
      const target = join(stage, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const directory = join(root, randomUUID());
    await rename(stage, directory);
    return {
      manifest,
      directory,
      clientDigest,
      machineDigest: manifest.machine ? hash(files.get(manifest.machine)!) : undefined,
      machineEntry: manifest.machine ? join(directory, manifest.machine) : undefined,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function inspectProposalPackage(path: string) {
  const bytes = await bounded(path, limit);
  const { manifest: m } = await verify(bytes);
  return {
    pluginId: m.id,
    title: m.title,
    version: m.version,
    sha256: hash(bytes),
    requestedCapabilities: pluginCapabilities(m),
  };
}
