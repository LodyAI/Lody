import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { assembleCoreSnapshot } from '../assemble-core-snapshot.mjs'
import { verifyCoreResources } from '../verify-core-resources.mjs'
import {
  readFile,
  readdir,
  lstat,
  mkdir,
  writeFile,
  realpath,
  mkdtemp,
  rm,
  open
} from 'node:fs/promises'
import { resolve, join, relative, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { sha256, signManifest, canonicalJson } from './protocol.mjs'
async function digestFile(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
async function compress(file, output, expected, dictionary) {
  const digest = createHash('sha256')
  const compressed = createHash('sha256')
  let length = 0
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk, encoding, done) {
        digest.update(chunk)
        done(null, chunk)
      }
    }),
    createZstdCompress(dictionary ? { dictionary } : {}),
    new Transform({
      transform(chunk, encoding, done) {
        length += chunk.length
        compressed.update(chunk)
        done(null, chunk)
      }
    }),
    createWriteStream(output, { flags: 'wx' })
  )
  if (digest.digest('hex') !== expected) throw new Error('Input changed during build')
  return { file: output, length, hash: compressed.digest('hex') }
}
async function immutableWrite(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await readFile(path)).equals(bytes)) throw new Error('Existing output differs')
  }
}
export async function buildRelease(o) {
  const input = await realpath(o.input)
  const requested = resolve(o.output)
  await mkdir(dirname(requested), { recursive: true })
  const output = join(await realpath(dirname(requested)), basename(requested))
  const rel = relative(input, output)
  if (!rel || (!rel.startsWith('..') && !rel.startsWith('/')))
    throw new Error('Output must be outside input')
  const maxPackBytes = o.maxPackBytes ?? 256 * 2 ** 20
  if (!Number.isSafeInteger(maxPackBytes) || maxPackBytes < 1 || maxPackBytes > 8 * 2 ** 30)
    throw new Error('Invalid pack memory budget')
  const tree = [],
    contents = new Map()
  const previous = o.previousInput ? await realpath(o.previousInput) : null
  let totalSize = 0
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name),
        path = prefix + name,
        stat = await lstat(full)
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not supported')
      if (stat.isDirectory()) await walk(full, path + '/')
      else if (stat.isFile()) {
        totalSize += stat.size
        if (totalSize > 32 * 2 ** 30) throw new Error('Core tree exceeds limit')
        if (stat.size > 256 * 2 ** 20 || tree.length >= 100000)
          throw new Error('Core input exceeds limits')
        const h = await digestFile(full)
        tree.push({ path, sha256: h, size: stat.size })
        contents.set(h, full)
      } else throw new Error('Unsupported Core file type')
    }
  }
  await walk(input)
  const objects = {},
    patches = []
  const packs = []
  await mkdir(output, { recursive: true })
  const spool = await mkdtemp(join(output, '.pack-'))
  let packFile = join(spool, 'pending')
  let packHandle = await open(packFile, 'wx')
  let packDigest = createHash('sha256')
  let pending = []
  let offset = 0
  await mkdir(join(output, 'packs'), { recursive: true })
  async function flush() {
    if (!pending.length) return
    if (packs.length >= 64) throw new Error('Too many packs')
    await packHandle.sync()
    await packHandle.close()
    const hash = packDigest.digest('hex')
    const bytes = o.returnPackBytes === false ? undefined : await readFile(packFile)
    const path = `packs/${hash}.pack`
    try {
      await (await import('node:fs/promises')).link(packFile, join(output, path))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const digest = createHash('sha256')
      for await (const chunk of (await import('node:fs')).createReadStream(join(output, path)))
        digest.update(chunk)
      if (digest.digest('hex') !== hash) throw new Error('Existing output differs')
    }
    await rm(packFile)
    packHandle = await open(packFile, 'wx')
    packDigest = createHash('sha256')
    for (const frame of pending) frame.packSha256 = hash
    packs.push({
      sha256: hash,
      path,
      size: offset,
      ...(o.returnPackBytes === false ? {} : { bytes })
    })
    pending = []
    offset = 0
  }
  async function append(bytes, descriptor) {
    if (bytes.length > maxPackBytes) throw new Error('Frame exceeds pack budget')
    if (offset + bytes.length > maxPackBytes) await flush()
    descriptor.offset = offset
    pending.push(descriptor)
    for await (const chunk of createReadStream(bytes.file)) {
      await packHandle.writeFile(chunk)
      packDigest.update(chunk)
    }
    await rm(bytes.file)
    offset += bytes.length
  }
  try {
    for (const h of [...contents.keys()].sort()) {
      const target = contents.get(h)
      const frame = await compress(target, join(spool, 'frame'), h)
      objects[h] = { packSha256: '', offset, length: frame.length, compressedSha256: frame.hash }
      await append(frame, objects[h])
      if (previous) {
        const candidate = tree.find((f) => f.sha256 === h).path
        const oldPath = join(previous, candidate)
        let base
        try {
          const resolved = await realpath(oldPath)
          const relation = relative(previous, resolved)
          if (relation.startsWith('..') || relation.startsWith('/'))
            throw new Error('Previous input escapes root')
          const stat = await lstat(oldPath)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 2 ** 20)
            throw new Error('Invalid previous input')
          base = await readFile(oldPath)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        if (base && sha256(base) !== h) {
          const patch = await compress(target, join(spool, 'patch'), h, base)
          if (patch.length + 256 < frame.length) {
            const replay = createHash('sha256')
            let replaySize = 0
            await pipeline(
              createReadStream(patch.file),
              createZstdDecompress({ dictionary: base }),
              new Transform({
                transform(chunk, encoding, done) {
                  replaySize += chunk.length
                  if (replaySize > tree.find((f) => f.sha256 === h).size)
                    return done(new Error('Oversized patch replay'))
                  replay.update(chunk)
                  done()
                }
              })
            )
            if (replay.digest('hex') !== h) throw new Error('Dictionary patch replay failed')
            const descriptor = {
              fromSha256: sha256(base),
              toSha256: h,
              packSha256: '',
              offset,
              length: patch.length,
              compressedSha256: patch.hash
            }
            patches.push(descriptor)
            await append(patch, descriptor)
          } else await rm(patch.file)
        }
      }
    }
    await flush()
    await packHandle.close()
  } finally {
    await packHandle.close().catch(() => {})
    await rm(spool, { recursive: true, force: true })
  }
  const manifest = signManifest(
    {
      schemaVersion: 1,
      releaseId: o.release,
      seq: o.seq,
      channel: o.channel,
      platform: o.platform,
      arch: o.arch,
      hostAbi: o.hostAbi,
      tree,
      packs: packs.map(({ sha256, path, size }) => ({ sha256, path, size })),
      objects,
      patches
    },
    o.privateKey ?? (await readFile(o.keyFile))
  )
  await mkdir(join(output, 'packs'), { recursive: true })
  await immutableWrite(join(output, 'manifest.json'), Buffer.from(canonicalJson(manifest) + '\n'))
  return { manifest, packs: packs.map(({ path, bytes }) => ({ path, bytes })) }
}
export async function buildDesktopRelease({ buildOutput, ...options }) {
  const snapshot = await mkdtemp(join(tmpdir(), 'core-publish-'))
  try {
    await assembleCoreSnapshot(buildOutput, join(snapshot, 'out'))
    await verifyCoreResources(join(snapshot, 'out'))
    return await buildRelease({ ...options, input: snapshot })
  } finally {
    await rm(snapshot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const o = {}
    const names = {
      'previous-input': 'previousInput',
      input: 'input',
      'build-output': 'buildOutput',
      output: 'output',
      release: 'release',
      seq: 'seq',
      channel: 'channel',
      platform: 'platform',
      arch: 'arch',
      'host-abi': 'hostAbi',
      'key-file': 'keyFile'
    }
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 2) {
      const k = names[args[i].slice(2)]
      if (!args[i].startsWith('--') || !k || !args[i + 1] || k in o)
        throw new Error('Invalid arguments')
      o[k] = args[i + 1]
    }
    if (Boolean(o.input) === Boolean(o.buildOutput)) throw new Error('Choose input or build-output')
    if (Object.keys(o).filter((k) => k !== 'previousInput').length !== 9)
      throw new Error('Missing arguments')
    if (!/^\d+$/.test(o.seq)) throw new Error('Invalid sequence')
    o.seq = Number(o.seq)
    await (o.buildOutput ? buildDesktopRelease : buildRelease)({ ...o, returnPackBytes: false })
  } catch {
    console.error('Core OTA build failed; check arguments, input, output and signing key')
    process.exitCode = 1
  }
}
