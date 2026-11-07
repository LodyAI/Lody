import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { sha256 } from './protocol.mjs'

export async function readObject(
  file,
  hash,
  size,
  { maxBytes = 256 * 2 ** 20, now = Date.now } = {}
) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size > Math.min(maxBytes, 256 * 2 ** 20) ||
      (size !== undefined && stat.size !== size)
    )
      throw Object.assign(new Error('Invalid cached object size'), { code: 'INVALID_OBJECT' })
    const bytes = await handle.readFile()
    if (
      bytes.length > Math.min(maxBytes, 256 * 2 ** 20) ||
      bytes.length !== stat.size ||
      (size !== undefined && bytes.length !== size)
    )
      throw Object.assign(new Error('Invalid cached object size'), { code: 'INVALID_OBJECT' })
    if (sha256(bytes) !== hash)
      throw Object.assign(new Error('Cached object hash mismatch'), { code: 'INVALID_OBJECT' })
    const used = new Date(now())
    await handle.utimes(used, used)
    return bytes
  } finally {
    await handle.close()
  }
}

export async function putObject(directory, hash, bytes) {
  if (sha256(bytes) !== hash) throw new Error('Object hash mismatch')
  const temporary = await fs.mkdtemp(path.join(directory, '.write-'))
  try {
    const file = path.join(temporary, hash)
    const handle = await fs.open(file, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(file, path.join(directory, hash))
    return path.join(directory, hash)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

export async function collectObjects(directory, protectedHashes, budget) {
  const entries = []
  let total = 0
  for (const name of await fs.readdir(directory)) {
    if (/^\.write-[a-zA-Z0-9]{6}$/.test(name)) {
      const temporary = path.join(directory, name)
      if ((await fs.lstat(temporary)).isDirectory())
        await fs.rm(temporary, { recursive: true, force: true })
      continue
    }
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    const file = path.join(directory, name)
    const stat = await fs.lstat(file).catch(() => null)
    if (!stat?.isFile()) continue
    total += stat.size
    if (!protectedHashes.has(name))
      entries.push({ file, size: stat.size, used: stat.mtimeMs, name })
  }
  for (const entry of entries.sort(
    (a, b) => a.used - b.used || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )) {
    if (total <= budget) break
    await fs.unlink(entry.file).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    total -= entry.size
  }
}
