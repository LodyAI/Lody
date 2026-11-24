import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema';
import { computeClientDigest } from '@lody/shared/plugins/digest';
import type { PluginBuild } from './workflow/dev-plugin-compiler';

// Uncompressed archive: magic, uint32 BE header length, UTF-8 integrity index, ordered file bodies.
const magic = Buffer.from('LODYPKG1\n'),
  limit = 32 * 1024 * 1024,
  headerLimit = 256 * 1024;
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
      ...[...(m.mcpServers ?? []), ...(m.acpProviders ?? [])].map((r) => r.entry),
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
function verify(bytes: Buffer) {
  if (
    !bytes.subarray(0, magic.length).equals(magic) ||
    bytes.length < magic.length + 4 ||
    bytes.length > limit
  )
    throw Error('Invalid package');
  const start = magic.length + 4,
    n = bytes.readUInt32BE(magic.length);
  if (n > headerLimit || start + n > bytes.length) throw Error('Invalid integrity manifest');
  const entries = index.parse(json(bytes.subarray(start, start + n)));
  let offset = start + n;
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (!portable(e.path) || seen.has(e.path.toLowerCase()) || offset + e.size > bytes.length)
      throw Error('Invalid package entry');
    seen.add(e.path.toLowerCase());
    const data = bytes.subarray(offset, (offset += e.size));
    if (hash(data) !== e.sha256) throw Error('Package integrity mismatch');
    files.set(e.path, data);
  }
  if (offset !== bytes.length) throw Error('Trailing package bytes');
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
    files.get('package.json')?.toString() !== '{"type":"module"}' ||
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
    const entries = [],
      parts = [];
    let total = 0;
    for (const path of paths(manifest)) {
      const bytes = await bounded(join(stage, path), limit - total);
      total += bytes.length;
      entries.push({ path, size: bytes.length, sha256: hash(bytes) });
      parts.push(bytes);
    }
    const header = Buffer.from(JSON.stringify(entries)),
      length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const archive = Buffer.concat([magic, length, header, ...parts]);
    verify(archive);
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
  const { manifest, files } = verify(bytes);
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

/** Inspect a release without extracting it or evaluating plugin code. */
export async function inspectProposalPackage(path: string) {
  const bytes = await bounded(path, limit);
  const { manifest: m } = verify(bytes);
  return {
    pluginId: m.id,
    title: m.title,
    version: m.version,
    sha256: hash(bytes),
    requestedCapabilities: [
      ...(m.machine ? ['machine'] : []),
      ...(m.client ? ['client'] : []),
      ...(
        ['skills', 'agentRoles', 'mcpServers', 'acpProviders', 'themes', 'styles'] as const
      ).filter((k) => m[k]?.length),
      ...(Object.values(m.config ?? {}).some((f) => f.type === 'secret') ? ['secrets'] : []),
    ],
  };
}
