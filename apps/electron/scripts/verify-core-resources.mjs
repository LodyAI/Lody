import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyCoreResources(root) {
  // window.js is pinned at main/ so its sibling resource directories belong
  // to the same release, both in an ASAR and in an external snapshot.
  for (const file of [
    'main/window.js',
    'preload/index.js',
    'renderer/index.html',
    'renderer/devbar.html',
    'renderer/pr-image.html',
    'renderer/recovery.html'
  ])
    assert.ok((await stat(resolve(root, file))).isFile(), `Missing Core resource: ${file}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyCoreResources(resolve(process.argv[2] ?? 'out'))
  console.log('Core resources verified')
}
