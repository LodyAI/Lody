import * as fs from 'node:fs/promises'
import path from 'node:path'
import { readObject, putObject, collectObjects } from './cas.mjs'
import { constants } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { validateManifest, verifyManifest, sha256 } from './protocol.mjs'

async function safeDirectory(directory) {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      await fs.mkdir(cursor)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (!(await fs.lstat(cursor)).isDirectory()) throw new Error('Unsafe store directory')
  }
  return absolute
}

const transfers = new Map()
export async function stageRelease(options) {
  const key = path.resolve(options.storeRoot)
  const previous = transfers.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => stage(options))
  transfers.set(key, current)
  try {
    return await current
  } finally {
    if (transfers.get(key) === current) transfers.delete(key)
  }
}

async function stage({
  manifest,
  publicKey,
  hostAbi,
  channel,
  platform,
  arch,
  baseUrl,
  storeRoot,
  localRoots = [],
  fetchImpl = fetch,
  signal,
  cacheBytes = 512 * 2 ** 20
}) {
  validateManifest(manifest)
  if (verifyManifest(manifest, publicKey) === false) throw new Error('Invalid manifest signature')
  for (const [key, value] of Object.entries({ hostAbi, channel, platform, arch })) {
    if (manifest[key] !== value) throw new Error(`Inapplicable manifest: ${key}`)
  }
  signal?.throwIfAborted()
  const stats = { requests: 0, downloadedBytes: 0, reusedObjects: 0, downloadedObjects: 0 }
  const budget = 512 * 2 ** 20
  let retained = 0
  const reserve = (bytes) => {
    if (retained + bytes > budget) throw new Error('Transfer memory budget exceeded')
    retained += bytes
  }
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error('Invalid cache budget')
  const root = await safeDirectory(storeRoot)
  const cas = await safeDirectory(path.join(root, '.objects'))
  try {
    const content = new Map()
    const sizes = new Map(manifest.tree.map((entry) => [entry.sha256, entry.size]))
    // Read candidates without following any symlink, including ancestor components.
    const wanted = new Set([...sizes.keys(), ...manifest.patches.map((p) => p.fromSha256)])
    await collectObjects(cas, wanted, cacheBytes)
    for (const hash of wanted) {
      const file = path.join(cas, hash)
      try {
        await readObject(file, hash, sizes.get(hash))
        content.set(hash, file)
      } catch (error) {
        if (!['ENOENT', 'ELOOP', 'INVALID_OBJECT'].includes(error.code)) throw error
      }
    }
    for (const root of localRoots) {
      if ((await fs.realpath(root).catch(() => null)) !== path.resolve(root))
        throw new Error('Unsafe local root')
      async function scan(directory) {
        signal?.throwIfAborted()
        if (!(await fs.lstat(directory)).isDirectory()) return
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) await scan(file)
          else if (entry.isFile()) {
            const candidateSize = (await fs.lstat(file)).size
            if (candidateSize > 256 * 2 ** 20) continue
            if (retained + candidateSize > budget)
              throw new Error('Transfer memory budget exceeded')
            if ((await fs.realpath(file)) !== path.resolve(file))
              throw new Error('Unsafe local file')
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
            let bytes
            try {
              const before = await handle.stat()
              if (!before.isFile() || before.size !== candidateSize)
                throw new Error('Local file changed')
              bytes = await handle.readFile()
              const after = await handle.stat()
              const named = await fs.lstat(file)
              if (
                before.dev !== named.dev ||
                before.ino !== named.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                (await fs.realpath(file)) !== path.resolve(file)
              )
                throw new Error('Local file changed')
            } finally {
              await handle.close()
            }
            const hash = sha256(bytes)
            if (wanted.has(hash) && !content.has(hash)) {
              content.set(hash, await putObject(cas, hash, bytes))
            }
          }
        }
      }
      try {
        await scan(root)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const packs = new Map(manifest.packs.map((pack) => [pack.sha256, pack]))
    const full = new Map()
    const selected = new Map()
    for (const hash of sizes.keys()) {
      if (content.has(hash)) {
        stats.reusedObjects++
        continue
      }
      const object = manifest.objects[hash]
      const patch = manifest.patches
        .filter((p) => p.toSha256 === hash && content.has(p.fromSha256) && p.length < object.length)
        .sort((a, b) => a.length - b.length)[0]
      selected.set(hash, patch ?? object)
    }
    const throughput = 10 * 2 ** 20,
      latency = 0.05,
      concurrency = 1
    const ranges = new Map(),
      rangeCache = new Map()
    function plan(frames, pack) {
      const merged = []
      for (const f of [...frames].sort((a, b) => a.offset - b.offset)) {
        const last = merged.at(-1)
        // A small gap costs less than another request on the estimated link.
        if (last && f.offset - last.end <= (throughput * latency) / concurrency)
          last.end = Math.max(last.end, f.offset + f.length)
        else merged.push({ offset: f.offset, end: f.offset + f.length })
      }
      const bytes = merged.reduce((n, r) => n + r.end - r.offset, 0)
      const cost = bytes / throughput + Math.ceil(merged.length / concurrency) * latency
      const fullCost = pack.size / throughput + latency
      return fullCost <= cost
        ? { cost: fullCost, ranges: [{ offset: 0, end: pack.size, entire: true }] }
        : { cost, ranges: merged }
    }
    for (const pack of packs.values()) {
      const entries = [...selected].filter(([, f]) => f.packSha256 === pack.sha256)
      if (!entries.length) continue
      const mixed = plan(
        entries.map(([, f]) => f),
        pack
      )
      const objects = entries.map(([h]) => manifest.objects[h])
      const samePack = objects.every((f) => f.packSha256 === pack.sha256)
      const complete = samePack ? plan(objects, pack) : null
      if (complete && complete.cost < mixed.cost) {
        for (const [h] of entries) selected.set(h, manifest.objects[h])
        ranges.set(pack.sha256, complete.ranges)
      } else ranges.set(pack.sha256, mixed.ranges)
    }
    async function request(pack, frame) {
      if (full.has(pack.sha256))
        return full.get(pack.sha256).subarray(frame.offset, frame.offset + frame.length)
      const planned = ranges
        .get(pack.sha256)
        ?.find((r) => r.offset <= frame.offset && r.end >= frame.offset + frame.length) ?? {
        offset: frame.offset,
        end: frame.offset + frame.length
      }
      const key = pack.sha256 + ':' + planned.offset + ':' + planned.end
      if (rangeCache.has(key))
        return rangeCache
          .get(key)
          .subarray(frame.offset - planned.offset, frame.offset - planned.offset + frame.length)
      const useFull = planned.entire === true
      let response
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted()
        stats.requests++
        response = await fetchImpl(new URL(pack.path, baseUrl), {
          signal,
          headers: useFull
            ? { 'Accept-Encoding': 'identity' }
            : { Range: `bytes=${planned.offset}-${planned.end - 1}`, 'Accept-Encoding': 'identity' }
        })
        if (response.status < 500 || attempt === 2) break
        await response.body?.cancel()
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      const entire = response.status === 200
      if (useFull && !entire) {
        await response.body?.cancel()
        throw new Error('Full pack requires HTTP 200')
      }
      const encoding = response.headers.get('content-encoding')
      if (encoding && encoding !== 'identity') {
        await response.body?.cancel()
        throw new Error('Invalid Content-Encoding')
      }
      const expected = entire ? pack.size : planned.end - planned.offset
      const declared = response.headers.get('content-length')
      if (declared !== null && declared !== String(expected)) {
        await response.body?.cancel()
        throw new Error('Invalid Content-Length')
      }
      if (
        !entire &&
        response.headers.get('content-range') !==
          `bytes ${planned.offset}-${planned.end - 1}/${pack.size}`
      ) {
        await response.body?.cancel()
        throw new Error('Invalid Content-Range')
      }
      if (retained + expected * 2 > budget) {
        full.clear()
        rangeCache.clear()
        retained = 0
      }
      if (expected * 2 > budget) {
        await response.body?.cancel()
        throw new Error('Transfer memory budget exceeded')
      }
      const chunks = []
      let length = 0
      for await (const chunk of response.body) {
        signal?.throwIfAborted()
        length += chunk.length
        if (length > expected) throw new Error('Oversized response')
        chunks.push(chunk)
      }
      if (length !== expected) throw new Error('Truncated response')
      stats.downloadedBytes += length
      const bytes = Buffer.concat(chunks)
      if (entire) {
        if (sha256(bytes) !== pack.sha256) throw new Error('Pack hash mismatch')
        reserve(bytes.length)
        full.set(pack.sha256, bytes)
        return bytes.subarray(frame.offset, frame.offset + frame.length)
      }
      reserve(bytes.length)
      rangeCache.set(key, bytes)
      return bytes.subarray(
        frame.offset - planned.offset,
        frame.offset - planned.offset + frame.length
      )
    }
    async function decode(hash, frame) {
      const compressed = await request(packs.get(frame.packSha256), frame)
      if (sha256(compressed) !== frame.compressedSha256) throw new Error('Compressed hash mismatch')
      if (retained + sizes.get(hash) + (frame.fromSha256 ? 256 * 2 ** 20 : 0) > budget) {
        full.clear()
        rangeCache.clear()
        retained = compressed.length
      }
      if (retained + sizes.get(hash) > budget) throw new Error('Transfer memory budget exceeded')
      const dictionary = frame.fromSha256
        ? await readObject(content.get(frame.fromSha256), frame.fromSha256, undefined, {
            maxBytes: budget - retained - sizes.get(hash)
          })
        : undefined
      if (retained + sizes.get(hash) + (dictionary?.length ?? 0) > budget)
        throw new Error('Transfer memory budget exceeded')
      const bytes = zstdDecompressSync(compressed, {
        maxOutputLength: Math.max(1, sizes.get(hash)),
        ...(dictionary ? { dictionary } : {})
      })
      if (bytes.length !== sizes.get(hash) || sha256(bytes) !== hash)
        throw new Error('Object hash mismatch')
      return putObject(cas, hash, bytes)
    }
    const staging = await fs.mkdtemp(path.join(root, '.stage-'))
    try {
      for (const [hash, frame] of selected) {
        try {
          content.set(hash, await decode(hash, frame))
        } catch (error) {
          signal?.throwIfAborted()
          if (!frame.fromSha256) throw error
          content.set(hash, await decode(hash, manifest.objects[hash]))
        }
        stats.downloadedObjects++
      }
      for (const entry of manifest.tree) {
        signal?.throwIfAborted()
        const destination = path.resolve(staging, entry.path)
        if (!destination.startsWith(staging + path.sep)) throw new Error('Unsafe tree path')
        await fs.mkdir(path.dirname(destination), { recursive: true })
        full.clear()
        rangeCache.clear()
        retained = 0
        await fs.writeFile(
          destination,
          await readObject(content.get(entry.sha256), entry.sha256, entry.size),
          { flag: 'wx' }
        )
      }
      signal?.throwIfAborted()
      const directory = path.join(root, sha256(Buffer.from(JSON.stringify(manifest))))
      async function verifyExisting() {
        if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Unsafe published release')
        const expected = new Map(manifest.tree.map((f) => [f.path, f]))
        async function walk(relative = '') {
          for (const entry of await fs.readdir(path.join(directory, relative), {
            withFileTypes: true
          })) {
            const name = relative ? relative + '/' + entry.name : entry.name
            if (entry.isDirectory()) {
              await walk(name)
              continue
            }
            const file = expected.get(name)
            if (!entry.isFile() || !file) throw new Error('Published release mismatch')
            if ((await fs.lstat(path.join(directory, name))).size !== file.size)
              throw new Error('Published release mismatch')
            if (retained + file.size > budget) throw new Error('Transfer memory budget exceeded')
            const bytes = await fs.readFile(path.join(directory, name))
            if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
              throw new Error('Published release mismatch')
            expected.delete(name)
          }
        }
        await walk()
        if (expected.size) throw new Error('Published release incomplete')
      }
      try {
        await fs.rename(staging, directory)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        await verifyExisting()
        await fs.rm(staging, { recursive: true, force: true })
      }
      return { directory, manifest, stats }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true })
      throw error
    }
  } finally {
    await collectObjects(cas, new Set(), cacheBytes)
  }
}
