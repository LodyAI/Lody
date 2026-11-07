import { pathToFileURL } from 'node:url'
import { readFile, mkdir, copyFile, cp, lstat } from 'node:fs/promises'
import { resolve, dirname, relative, isAbsolute } from 'node:path'

export async function assembleCoreSnapshot(input, output) {
  input = resolve(input)
  output = resolve(output)
  const relation = relative(input, output)
  if (!relation || (!relation.startsWith('..') && !isAbsolute(relation)))
    throw new Error('Snapshot must be outside build output')
  const manifest = JSON.parse(await readFile(resolve(input, 'main/core-artifacts.json'), 'utf8'))
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.main) ||
    !manifest.main.includes('application.js')
  )
    throw new Error('Invalid Core artifact manifest')
  await mkdir(output, { recursive: false })
  for (const name of manifest.main) {
    if (typeof name !== 'string' || name.includes('..') || isAbsolute(name) || name.includes('\\'))
      throw new Error('Invalid Core artifact path')
    const source = resolve(input, 'main', name)
    if (!(await lstat(source)).isFile()) throw new Error('Core artifact must be a regular file')
    const target = resolve(output, 'main', name)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  for (const section of ['preload', 'renderer'])
    await cp(resolve(input, section), resolve(output, section), {
      recursive: true,
      dereference: false
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output || process.argv.length !== 4)
    throw new Error('Usage: assemble-core-snapshot.mjs <build-out> <new-snapshot-directory>')
  await assembleCoreSnapshot(input, output)
}
