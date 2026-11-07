import {
  mkdir,
  open,
  readFile,
  rename,
  lstat,
  readdir,
  cp,
  chmod,
  rm,
  writeFile,
  realpath
} from 'node:fs/promises'
import path from 'node:path'
import { verifyManifest, sha256 } from './protocol.mjs'
import { randomUUID, createHash } from 'node:crypto'

async function persist(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  const directory = await open(path.dirname(file), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

// The caller supplies a kernel-backed exclusive lease spanning the process lifetime.
// No PID/age takeover is safe: an old owner may still be executing downloaded code.
export async function openActivation({ root, installed, lease, publicKey }) {
  if (!lease || typeof lease.assertHeld !== 'function')
    throw new Error('Exclusive host lease required')
  const namespace = createHash('sha256')
    .update(
      JSON.stringify([
        installed.product,
        installed.channel,
        installed.platform,
        installed.arch,
        installed.hostAbi
      ])
    )
    .digest('hex')
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Linked activation root refused')
  const directory = path.join(await realpath(root), namespace)
  await lease.assertHeld()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await realpath(directory)) !== path.resolve(directory))
    throw new Error('Linked activation root refused')
  const file = path.join(directory, 'pointer.json')
  let state
  try {
    state = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { current: null, previous: null, staged: null, attempt: null, rejected: [], seq: -1 }
  }
  const validId = (value) =>
    value === null ||
    (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    Object.keys(state).sort().join() !== 'attempt,current,previous,rejected,seq,staged' ||
    !['current', 'previous', 'staged'].every((key) => validId(state[key])) ||
    !Number.isSafeInteger(state.seq) ||
    state.seq < -1 ||
    !Array.isArray(state.rejected) ||
    state.rejected.some((id) => id === null || !validId(id)) ||
    (state.attempt !== null &&
      (!state.attempt ||
        typeof state.attempt !== 'object' ||
        Object.keys(state.attempt).sort().join() !== 'attemptId,releaseId' ||
        state.attempt.releaseId !== state.current ||
        state.current === null ||
        typeof state.attempt.attemptId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(state.attempt.attemptId)))
  ) {
    throw new Error('Invalid Core activation pointer')
  }
  const save = async () => {
    await lease.assertHeld()
    await persist(file, state)
  }
  const verify = async (id) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid release id')
    const result = await verifyRelease(path.join(directory, 'releases', id), publicKey)
    if (result.releaseId !== id) throw new Error('Release identity mismatch')
    for (const key of ['channel', 'platform', 'arch', 'hostAbi']) {
      if (result[key] !== installed[key]) throw new Error(`Incompatible ${key}`)
    }
    return result
  }
  return {
    directory,
    async adoptStaged({ directory: sourceDirectory, manifest: suppliedManifest }) {
      await lease.assertHeld()
      const manifest = await verifyRelease(sourceDirectory, publicKey, suppliedManifest)
      for (const key of ['channel', 'platform', 'arch', 'hostAbi']) {
        if (manifest[key] !== installed[key]) throw new Error(`Incompatible ${key}`)
      }
      if (state.rejected.includes(manifest.releaseId) || manifest.seq <= state.seq)
        throw new Error('Rejected or stale release')
      const releases = path.join(directory, 'releases')
      await mkdir(releases, { recursive: true, mode: 0o700 })
      const temporary = path.join(releases, `.incoming-${randomUUID()}`)
      try {
        await cp(sourceDirectory, temporary, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false
        })
        await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), {
          flag: 'wx',
          mode: 0o600
        })
        await verifyRelease(temporary, publicKey)
        async function seal(dir) {
          for (const name of await readdir(dir)) {
            const file = path.join(dir, name)
            if ((await lstat(file)).isDirectory()) await seal(file)
            else {
              const handle = await open(file, 'r')
              try {
                await handle.sync()
              } finally {
                await handle.close()
              }
              await chmod(file, 0o400)
            }
          }
          const handle = await open(dir, 'r')
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
          await chmod(dir, 0o500)
        }
        await seal(temporary)
        await lease.assertHeld()
        await rename(temporary, path.join(releases, manifest.releaseId))
        const handle = await open(releases, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        state.staged = manifest.releaseId
        state.seq = manifest.seq
        await save()
        return manifest.releaseId
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => {})
      }
    },
    async stage(releaseId) {
      const manifest = await verify(releaseId)
      if (state.rejected.includes(releaseId) || manifest.seq <= state.seq)
        throw new Error('Rejected or stale release')
      state.staged = releaseId
      state.seq = manifest.seq
      await save()
    },
    async begin() {
      await lease.assertHeld()
      if (state.attempt) {
        state.rejected = [...new Set([...state.rejected, state.attempt.releaseId])]
        state.current = state.previous
        state.previous = null
        state.attempt = null
      }
      if (state.staged) {
        state.previous = state.current
        state.current = state.staged
        state.staged = null
      }
      if (state.current) {
        try {
          await verify(state.current)
        } catch {
          state.rejected = [...new Set([...state.rejected, state.current])]
          state.current = null
        }
      }
      const attemptId = randomUUID()
      state.attempt = state.current ? { releaseId: state.current, attemptId } : null
      await save()
      return { releaseId: state.current, attemptId, builtin: !state.current }
    },
    async fail({ releaseId, attemptId }) {
      await lease.assertHeld()
      if (state.attempt?.releaseId !== releaseId || state.attempt?.attemptId !== attemptId)
        throw new Error('Stale failure acknowledgement')
      state.rejected = [...new Set([...state.rejected, releaseId])]
      state.current = state.previous
      state.previous = null
      state.attempt = null
      await save()
    },
    // A deliberate shutdown keeps the release eligible for a fresh health attempt.
    async abandon({ releaseId, attemptId }) {
      await lease.assertHeld()
      if (state.attempt?.releaseId !== releaseId || state.attempt?.attemptId !== attemptId)
        throw new Error('Stale shutdown acknowledgement')
      state.attempt = null
      await save()
    },
    async acknowledge({ releaseId, attemptId }) {
      if (state.attempt?.releaseId !== releaseId || state.attempt?.attemptId !== attemptId)
        throw new Error('Stale health acknowledgement')
      state.attempt = null
      await save()
    }
  }
}

export async function verifyRelease(directory, publicKey, suppliedManifest) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked release root refused')
  if (!(await lstat(directory)).isDirectory()) throw new Error('Release must be a directory')
  const manifestPath = path.join(directory, 'manifest.json')
  if (suppliedManifest === undefined && !(await lstat(manifestPath)).isFile())
    throw new Error('Invalid manifest file')
  const manifest = verifyManifest(
    suppliedManifest ?? JSON.parse(await readFile(manifestPath, 'utf8')),
    publicKey
  )
  const expected = new Map(manifest.tree.map((file) => [file.path, file]))
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative))) {
      const name = relative ? `${relative}/${entry}` : entry
      if (name === 'manifest.json' && suppliedManifest === undefined) continue
      const absolute = path.join(directory, name)
      const stat = await lstat(absolute)
      if (stat.isDirectory()) {
        await walk(name)
        continue
      }
      const file = expected.get(name)
      if (
        !stat.isFile() ||
        !file ||
        stat.size !== file.size ||
        sha256(await readFile(absolute)) !== file.sha256
      )
        throw new Error('Corrupt release tree')
      expected.delete(name)
    }
  }
  await walk()
  if (expected.size) throw new Error('Incomplete release tree')
  return manifest
}
