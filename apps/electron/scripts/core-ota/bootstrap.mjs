import { validateCapabilities } from './compatibility.mjs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { openActivation } from './activation.mjs'

export const INSTALLED_METADATA_PATH = 'core-ota-host.json'
export const CORE_APPLICATION_ENTRY = 'out/main/application.js'

// resourcesPath and isOwner are supplied by the installed Host after its
// app.requestSingleInstanceLock succeeds. Ownership remains held until quit.
export async function openInstalledCore({ resourcesPath, root, isOwner }) {
  const installed = JSON.parse(
    await readFile(path.join(resourcesPath, INSTALLED_METADATA_PATH), 'utf8')
  )
  if (
    installed.schemaVersion !== 2 ||
    Object.keys(installed).sort().join() !==
      'arch,channel,feedUrl,hostAbi,hostBuildId,hostCapabilities,platform,product,publicKey,schemaVersion'
  )
    throw new Error('Invalid installed Core metadata')
  for (const key of ['product', 'channel', 'platform', 'arch', 'hostAbi', 'hostBuildId']) {
    if (
      typeof installed[key] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(installed[key])
    )
      throw new Error(`Invalid installed ${key}`)
  }
  validateCapabilities(installed.hostCapabilities)
  if (typeof installed.publicKey !== 'string' || !installed.publicKey)
    throw new Error('Installed public key required')
  const feed = new URL(installed.feedUrl)
  if (feed.protocol !== 'https:' || feed.username || feed.password)
    throw new Error('Invalid installed feed URL')
  const lease = {
    assertHeld() {
      if (typeof isOwner !== 'function' || isOwner() !== true)
        throw new Error('Installed Host ownership required')
    }
  }
  lease.assertHeld()
  return openActivation({
    root,
    installed: Object.freeze(installed),
    publicKey: installed.publicKey,
    lease
  })
}

// The installed index retains identity, launch routing, and resource custody.
// It imports only the selected application module after this returns.
export async function bootstrapCore(options) {
  let activation
  try {
    activation = await openInstalledCore(options)
  } catch (error) {
    return {
      activation: null,
      selection: { builtin: true, releaseId: null, attemptId: null },
      entry: null,
      otaError: error
    }
  }
  const selection = await activation.begin()
  return {
    activation,
    selection,
    entry: selection.builtin
      ? null
      : path.join(activation.directory, 'releases', selection.releaseId, CORE_APPLICATION_ENTRY)
  }
}
