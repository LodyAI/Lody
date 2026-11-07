import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { readObject, collectObjects, verifyObject } from './cas.mjs'
import { constants } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
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
const origins = new Map()
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
  now = () => performance.now(),
  maxSpoolBytes = 8 * 2 ** 30,
  cacheBytes = 512 * 2 ** 20
}) {
  validateManifest(manifest)
  if (verifyManifest(manifest, publicKey) === false) throw new Error('Invalid manifest signature')
  for (const [key, value] of Object.entries({ hostAbi, channel, platform, arch })) {
    if (manifest[key] !== value) throw new Error(`Inapplicable manifest: ${key}`)
  }
  signal?.throwIfAborted()
  const started = now()
  const cpuStarted = process.cpuUsage()
  let spoolBytes = 0
  let usefulBytes = 0
  const stats = {
    planModes: { mixed: 0, object: 0, full: 0 },
    requestedBytes: 0,
    wasteBytes: 0,
    peakSpoolBytes: 0,
    requests: 0,
    downloadedBytes: 0,
    reusedObjects: 0,
    downloadedObjects: 0
  }
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error('Invalid cache budget')
  const root = await safeDirectory(storeRoot)
  for (const name of await fs.readdir(root)) {
    if (!/^\.(?:download|stage)-[a-zA-Z0-9]{6}$/.test(name)) continue
    const temporary = path.join(root, name)
    const stat = await fs.lstat(temporary).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isDirectory()) await fs.rm(temporary, { recursive: true, force: true })
  }
  const cas = await safeDirectory(path.join(root, '.objects'))
  const spool = await fs.mkdtemp(path.join(root, '.download-'))
  try {
    const content = new Map()
    const sizes = new Map(manifest.tree.map((entry) => [entry.sha256, entry.size]))
    // Read candidates without following any symlink, including ancestor components.
    const wanted = new Set([...sizes.keys(), ...manifest.patches.map((p) => p.fromSha256)])
    await collectObjects(cas, wanted, cacheBytes)
    for (const hash of wanted) {
      const file = path.join(cas, hash)
      try {
        await verifyObject(file, hash, sizes.get(hash))
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
            if ((await fs.realpath(file)) !== path.resolve(file))
              throw new Error('Unsafe local file')
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
            let hash
            try {
              const before = await handle.stat()
              if (!before.isFile() || before.size !== candidateSize)
                throw new Error('Local file changed')
              const digest = createHash('sha256')
              for await (const chunk of handle.createReadStream({ autoClose: false }))
                digest.update(chunk)
              hash = digest.digest('hex')
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
            if (wanted.has(hash) && !content.has(hash)) {
              const temporary = await fs.mkdtemp(path.join(cas, '.write-'))
              try {
                const copy = path.join(temporary, hash)
                await pipeline(
                  createReadStream(file),
                  createWriteStream(copy, { flags: 'wx', flush: true }),
                  {
                    signal
                  }
                )
                await verifyObject(copy, hash, candidateSize)
                await fs.rename(copy, path.join(cas, hash))
                content.set(hash, path.join(cas, hash))
              } finally {
                await fs.rm(temporary, { recursive: true, force: true })
              }
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
    const origin = new URL(baseUrl).origin
    const estimate = { ...(origins.get(origin) ?? { throughput: 10 * 2 ** 20, latency: 0.05 }) }
    if (origins.has(origin)) {
      origins.delete(origin)
      origins.set(origin, { ...estimate })
    }
    const concurrency = 1
    const ranges = new Map(),
      rangeCache = new Map()
    function plan(frames, pack) {
      const { throughput, latency } = estimate
      const merged = []
      for (const f of [...frames].sort((a, b) => a.offset - b.offset)) {
        const last = merged.at(-1)
        // A small gap costs less than another request on the estimated link.
        if (
          last &&
          f.offset + f.length - last.offset <= Math.min(16 * 2 ** 20, maxSpoolBytes) &&
          f.offset - last.end <= (throughput * latency) / concurrency
        )
          last.end = Math.max(last.end, f.offset + f.length)
        else merged.push({ offset: f.offset, end: f.offset + f.length })
      }
      const bytes = merged.reduce((n, r) => n + r.end - r.offset, 0)
      const cost = bytes / throughput + Math.ceil(merged.length / concurrency) * latency
      const fullCost = pack.size / throughput + latency
      return pack.size <= maxSpoolBytes && fullCost <= cost
        ? { cost: fullCost, ranges: [{ offset: 0, end: pack.size, entire: true }] }
        : { cost, ranges: merged }
    }
    let planMode = 'object'
    function candidate(entries) {
      const grouped = new Map()
      for (const [, frame] of entries) {
        const list = grouped.get(frame.packSha256) ?? []
        list.push(frame)
        grouped.set(frame.packSha256, list)
      }
      const planned = new Map()
      let cost = 0
      for (const [hash, frames] of grouped) {
        const missing = frames.filter(
          (frame) =>
            ![...full.values(), ...rangeCache.values()].some(
              (record) =>
                record.pack === hash &&
                record.offset <= frame.offset &&
                record.end >= frame.offset + frame.length
            )
        )
        const result = missing.length ? plan(missing, packs.get(hash)) : { cost: 0, ranges: [] }
        planned.set(hash, result.ranges)
        cost += result.cost
      }
      return { cost, planned }
    }
    function replan() {
      const remaining = [...selected].filter(([hash]) => !content.has(hash))
      const mixed = remaining.map(([hash]) => {
        const object = manifest.objects[hash]
        const patch = manifest.patches
          .filter(
            (p) => p.toSha256 === hash && content.has(p.fromSha256) && p.length < object.length
          )
          .sort((a, b) => a.length - b.length)[0]
        return [hash, patch ?? object]
      })
      const objects = remaining.map(([hash]) => [hash, manifest.objects[hash]])
      const mixedPlan = candidate(mixed)
      const objectPlan = candidate(objects)
      const useObjects = objectPlan.cost < mixedPlan.cost
      const chosen = useObjects ? objects : mixed
      planMode = chosen.some(([, frame]) => frame.fromSha256) ? 'mixed' : 'object'
      for (const [hash, frame] of chosen) selected.set(hash, frame)
      ranges.clear()
      for (const [hash, list] of (useObjects ? objectPlan : mixedPlan).planned)
        ranges.set(hash, list)
    }
    async function evict(record) {
      await fs.rm(record.file, { force: true })
      spoolBytes -= record.end - record.offset
      for (const [key, value] of full) if (value === record) full.delete(key)
      for (const [key, value] of rangeCache) if (value === record) rangeCache.delete(key)
    }
    async function releaseUnused() {
      for (const record of new Set([...full.values(), ...rangeCache.values()])) {
        const needed = [...selected].some(
          ([hash, frame]) =>
            !content.has(hash) &&
            frame.packSha256 === record.pack &&
            frame.offset >= record.offset &&
            frame.offset + frame.length <= record.end
        )
        if (!needed) await evict(record)
      }
    }
    async function request(pack, frame) {
      async function slice(record) {
        return {
          file: record.file,
          start: frame.offset - record.offset,
          end: frame.offset - record.offset + frame.length - 1
        }
      }
      if (full.has(pack.sha256)) return slice(full.get(pack.sha256))
      for (const record of rangeCache.values()) {
        if (
          record.pack === pack.sha256 &&
          record.offset <= frame.offset &&
          record.end >= frame.offset + frame.length
        )
          return slice(record)
      }
      const planned = ranges
        .get(pack.sha256)
        ?.find((r) => r.offset <= frame.offset && r.end >= frame.offset + frame.length) ?? {
        offset: frame.offset,
        end: frame.offset + frame.length
      }
      const key = pack.sha256 + ':' + planned.offset + ':' + planned.end
      if (rangeCache.has(key)) return slice(rangeCache.get(key))
      const useFull = planned.entire === true
      let response
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted()
        const requestStarted = now()
        stats.requests++
        stats.requestedBytes += useFull ? pack.size : planned.end - planned.offset
        response = await fetchImpl(new URL(pack.path, baseUrl), {
          signal,
          headers: useFull
            ? { 'Accept-Encoding': 'identity' }
            : { Range: `bytes=${planned.offset}-${planned.end - 1}`, 'Accept-Encoding': 'identity' }
        })
        estimate.latency = Math.max(0.000001, (now() - requestStarted) / 1000)
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
      for (const record of new Set([...full.values(), ...rangeCache.values()])) {
        if (spoolBytes + expected <= maxSpoolBytes) break
        await evict(record)
      }
      stats.planModes[useFull ? 'full' : planMode]++
      if (
        !Number.isSafeInteger(maxSpoolBytes) ||
        maxSpoolBytes < 1 ||
        spoolBytes + expected > maxSpoolBytes
      ) {
        await response.body?.cancel()
        throw new Error('Transfer disk budget exceeded')
      }
      const bodyStarted = now()
      const file = path.join(spool, String(stats.requests))
      const handle = await fs.open(file, 'wx')
      const digest = createHash('sha256')
      let length = 0
      try {
        for await (const chunk of response.body) {
          signal?.throwIfAborted()
          length += chunk.length
          stats.downloadedBytes += chunk.length
          if (length > expected) throw new Error('Oversized response')
          digest.update(chunk)
          await handle.writeFile(chunk)
        }
      } catch (error) {
        await handle.close()
        await fs.rm(file, { force: true })
        throw error
      } finally {
        await handle.close()
      }
      if (length !== expected) {
        await fs.rm(file, { force: true })
        throw new Error('Truncated response')
      }
      spoolBytes += length
      stats.peakSpoolBytes = Math.max(stats.peakSpoolBytes, spoolBytes)
      estimate.throughput = length / Math.max(0.000001, (now() - bodyStarted) / 1000)
      origins.delete(origin)
      origins.set(origin, { ...estimate })
      while (origins.size > 32) origins.delete(origins.keys().next().value)
      if (entire && digest.digest('hex') !== pack.sha256) {
        await fs.rm(file, { force: true })
        spoolBytes -= length
        throw new Error('Pack hash mismatch')
      }
      const record = {
        file,
        pack: pack.sha256,
        end: entire ? pack.size : planned.end,
        offset: entire ? 0 : planned.offset
      }
      if (entire) full.set(pack.sha256, record)
      else rangeCache.set(key, record)
      return slice(record)
    }

    async function decode(hash, frame) {
      const compressed = await request(packs.get(frame.packSha256), frame)
      const compressedDigest = createHash('sha256')
      for await (const chunk of createReadStream(compressed.file, {
        start: compressed.start,
        end: compressed.end
      }))
        compressedDigest.update(chunk)
      if (compressedDigest.digest('hex') !== frame.compressedSha256)
        throw new Error('Compressed hash mismatch')
      const dictionary = frame.fromSha256
        ? await readObject(content.get(frame.fromSha256), frame.fromSha256, undefined, {
            maxBytes: 256 * 2 ** 20
          })
        : undefined
      const temporary = await fs.mkdtemp(path.join(cas, '.write-'))
      const file = path.join(temporary, hash)
      const digest = createHash('sha256')
      let length = 0
      try {
        await pipeline(
          createReadStream(compressed.file, { start: compressed.start, end: compressed.end }),
          createZstdDecompress(dictionary ? { dictionary } : {}),
          new Transform({
            transform(chunk, encoding, callback) {
              length += chunk.length
              if (length > sizes.get(hash)) return callback(new Error('Oversized object'))
              digest.update(chunk)
              callback(null, chunk)
            }
          }),
          createWriteStream(file, { flags: 'wx' }),
          { signal }
        )
        if (length !== sizes.get(hash) || digest.digest('hex') !== hash)
          throw new Error('Object hash mismatch')
        const completed = await fs.open(file, 'r+')
        try {
          await completed.sync()
        } finally {
          await completed.close()
        }
        usefulBytes += frame.length
        await fs.rename(file, path.join(cas, hash))
        return path.join(cas, hash)
      } finally {
        await fs.rm(temporary, { recursive: true, force: true })
      }
    }

    const staging = await fs.mkdtemp(path.join(root, '.stage-'))
    try {
      for (const hash of selected.keys()) {
        replan()
        const frame = selected.get(hash)
        try {
          content.set(hash, await decode(hash, frame))
        } catch (error) {
          signal?.throwIfAborted()
          if (!frame.fromSha256) throw error
          selected.set(hash, manifest.objects[hash])
          planMode = 'object'
          ranges.clear()
          content.set(hash, await decode(hash, manifest.objects[hash]))
        }
        await releaseUnused()
        stats.downloadedObjects++
      }
      for (const entry of manifest.tree) {
        signal?.throwIfAborted()
        const destination = path.resolve(staging, entry.path)
        if (!destination.startsWith(staging + path.sep)) throw new Error('Unsafe tree path')
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await verifyObject(content.get(entry.sha256), entry.sha256, entry.size)
        await pipeline(
          createReadStream(content.get(entry.sha256)),
          createWriteStream(destination, { flags: 'wx', flush: true }),
          { signal }
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
            await verifyObject(path.join(directory, name), file.sha256, file.size)
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
      stats.usefulBytes = usefulBytes
      stats.wasteBytes = stats.downloadedBytes - usefulBytes
      stats.elapsedMs = now() - started
      stats.cpu = process.cpuUsage(cpuStarted)
      stats.processLifetimePeakRssBytes = process.resourceUsage().maxRSS * 1024
      return { directory, manifest, stats }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true })
      throw error
    }
  } finally {
    await fs.rm(spool, { recursive: true, force: true })
    await collectObjects(cas, new Set(), cacheBytes)
  }
}
