import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, lstat, readlink } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson } from './protocol.mjs'

// Identity of the pre-signing installation payload. Never use it to decide
// whether a signed Core's capability requirements can run on another build.
export async function computeHostBuildId(root, metadataFile, metadata) {
  const hash = createHash('sha256').update(canonicalJson(metadata))
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name)
      if (file === metadataFile) continue
      const relative = path.relative(root, file).split(path.sep).join('/')
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) hash.update(`${relative}:link:${await readlink(file)}\0`)
      else if (stat.isDirectory()) await walk(file)
      else if (stat.isFile()) {
        hash.update(`${relative}\0${stat.size}\0`)
        for await (const bytes of createReadStream(file)) hash.update(bytes)
      }
    }
  }
  await walk(root)
  return hash.digest('hex')
}
