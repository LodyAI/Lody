import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, isBuiltin, registerHooks } from 'node:module'
import type { ElectronUpdaterState } from '@lody/shared/electron-ipc'
// Host-owned modules are bundled with the installed entry, never supplied by a feed.
// @ts-ignore standalone Node ESM host module
import { bootstrapCore } from '../../../scripts/core-ota/bootstrap.mjs'
// @ts-ignore standalone Node ESM host module
import { verifyRelease } from '../../../scripts/core-ota/activation.mjs'
// @ts-ignore standalone Node ESM host module
import { stageRelease } from '../../../scripts/core-ota/download.mjs'

export class CoreUpdaterService {
  private pending = false
  private downloaded = false
  private abort?: AbortController
  private healthy = false
  private shuttingDown = false
  private healthTimer?: ReturnType<typeof setTimeout>
  private recovering = false
  private rescue?: () => unknown
  private mainReady = false
  private rendererReady = false
  private selection: any
  private metadata: any
  private activation: any
  private fetchImpl: typeof fetch
  constructor(metadata: any, activation: any, fetchImpl: typeof fetch = fetch) {
    this.metadata = metadata
    this.activation = activation
    this.fetchImpl = fetchImpl
  }

  static async open(resources: string, root: string, isOwner: () => boolean, rescue?: () => void) {
    let context
    try {
      context = await bootstrapCore({ resourcesPath: resources, root, isOwner })
    } catch {
      console.warn('[Core OTA] Activation unavailable; continuing installed application')
      return null
    }
    if (!context.activation) return null
    const metadata = JSON.parse(await readFile(join(resources, 'core-ota-host.json'), 'utf8'))
    if (metadata.platform !== process.platform || metadata.arch !== process.arch)
      throw new Error('Invalid installed Core target')
    const service = new CoreUpdaterService(metadata, context.activation)
    service.rescue = rescue
    service.selection = context.selection
    service.entry = context.entry
    service.installedApplication = join(resources, 'app.asar/out/main/application.js')
    return service
  }

  private entry: string | null = null
  private installedApplication: string | null = null
  private resolver?: ReturnType<typeof registerHooks>
  async loadApplication(builtin: () => Promise<any>) {
    if (!this.entry) return builtin()
    this.healthTimer = setTimeout(() => {
      void this.failInitialHealth().catch(console.error)
    }, 60_000)
    this.healthTimer.unref()
    if (!this.resolver && this.installedApplication) {
      const installedRequire = createRequire(this.installedApplication)
      const installedParentURL = pathToFileURL(this.installedApplication).href
      const releaseUrl = pathToFileURL(join(this.entry, '../../..') + '/').href
      this.resolver = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (
            context.parentURL?.startsWith(releaseUrl) &&
            !isBuiltin(specifier) &&
            specifier !== 'electron' &&
            !specifier.startsWith('.') &&
            !specifier.startsWith('/') &&
            !specifier.includes(':')
          ) {
            if (context.conditions.includes('require')) {
              return {
                url: pathToFileURL(installedRequire.resolve(specifier)).href,
                shortCircuit: true
              }
            }
            return nextResolve(specifier, { ...context, parentURL: installedParentURL })
          }
          return nextResolve(specifier, context)
        }
      })
    }
    try {
      return await import(/* @vite-ignore */ pathToFileURL(this.entry).href)
    } catch (error) {
      this.resolver?.deregister()
      this.resolver = undefined
      await this.failInitialHealth()
      throw error
    }
  }

  setHealthRescue(rescue: () => unknown) {
    this.rescue = rescue
  }

  private async failInitialHealth() {
    if (this.healthy || this.recovering || this.shuttingDown) return
    this.recovering = true
    if (this.healthTimer) clearTimeout(this.healthTimer)
    await this.activation.fail(this.selection)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => this.rescue?.()),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Core recovery quit remains unconfirmed')),
            15_000
          )
          timer.unref()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async markMainReady() {
    this.mainReady = true
    if (this.rendererReady) await this.acknowledgeHealthy()
  }

  async abandonHealthAttempt() {
    this.shuttingDown = true
    if (this.healthTimer) clearTimeout(this.healthTimer)
    if (!this.recovering && this.selection && !this.selection.builtin && !this.healthy)
      await this.activation.abandon(this.selection).catch((error: unknown) => {
        console.warn('[Core OTA] Could not record graceful shutdown', error)
      })
  }

  async acknowledgeHealthy() {
    this.rendererReady = true
    if (!this.mainReady || this.recovering || this.shuttingDown) return
    if (!this.selection || this.selection.builtin || this.healthy) return
    await this.activation.acknowledge(this.selection)
    this.healthy = true
    if (this.healthTimer) clearTimeout(this.healthTimer)
  }

  stop() {
    this.abort?.abort()
  }
  get ready() {
    return this.downloaded
  }
  private async localRoots(): Promise<string[]> {
    const roots: string[] = []
    const releases = join(this.activation.directory, 'releases')
    try {
      for (const entry of await readdir(releases, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const directory = join(releases, entry.name)
        try {
          await verifyRelease(directory, this.metadata.publicKey)
          roots.push(await realpath(directory))
        } catch {
          /* A corrupt retained release is not a reuse source. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.installedApplication) {
      const builtinOut = join(this.installedApplication, '../..')
      try {
        if ((await lstat(builtinOut)).isDirectory()) roots.push(await realpath(builtinOut))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return roots
  }

  async check(publish: (state: Partial<ElectronUpdaterState>) => void) {
    if (this.downloaded) return { handled: true, started: true }
    if (this.pending) return { handled: true, started: false, error: 'check_in_progress' }
    this.pending = true
    this.abort = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)])
    publish({ phase: 'checking', error: undefined })
    try {
      const response = await this.fetchImpl(this.metadata.feedUrl, {
        signal,
        credentials: 'omit',
        redirect: 'error'
      })
      if (response.status === 404 || response.status === 204) {
        await response.body?.cancel()
        return { handled: false, started: false }
      }
      if (!response.ok) throw new Error(`Core feed HTTP ${response.status}`)
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body!) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new Error('Core manifest exceeds limit')
        chunks.push(chunk)
      }
      const manifest = parseCoreManifest(Buffer.concat(chunks).toString('utf8'))
      if (
        ['hostAbi', 'channel', 'platform', 'arch'].some(
          (key) => manifest[key] !== this.metadata[key]
        )
      )
        return { handled: false, started: false }
      if (manifest.releaseId === this.selection?.releaseId) {
        publish({ phase: 'up_to_date' })
        return { handled: false, started: true }
      }
      publish({ phase: 'downloading' })
      const staged = await stageRelease({
        ...this.metadata,
        manifest,
        baseUrl: new URL('.', this.metadata.feedUrl).href,
        storeRoot: join(this.activation.directory, 'downloads'),
        localRoots: await this.localRoots(),
        fetchImpl: this.fetchImpl,
        signal
      })
      await this.activation.adoptStaged(staged)
      this.downloaded = true
      publish({
        phase: 'downloaded',
        availableVersion: manifest.releaseId,
        downloadedVersion: manifest.releaseId,
        checkedAtMs: Date.now()
      })
      return { handled: true, started: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Core update failed'
      publish({ phase: this.downloaded ? 'downloaded' : 'error', error: message })
      return { handled: false, started: false, error: message }
    } finally {
      this.pending = false
      this.abort = undefined
    }
  }
}

// Shared by Host and Core bundles through the process object, not a second module singleton.
const contextKey = Symbol.for('lody.core-updater')
export function setCoreUpdater(service: CoreUpdaterService) {
  ;(process as any)[contextKey] = service
}
export function getCoreUpdater(): CoreUpdaterService | undefined {
  return (process as any)[contextKey]
}

export function parseCoreManifest(text: string) {
  const stack: Array<Set<string> | null> = []
  let previous = ''
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/gs)) {
    const token = match[0]
    if (token === '{') stack.push(new Set())
    else if (token === '[') stack.push(null)
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ':' && stack.at(-1)) {
      const key = JSON.parse(previous)
      if (stack.at(-1)!.has(key)) throw new Error('Duplicate Core manifest key')
      stack.at(-1)!.add(key)
    }
    previous = token
  }
  return JSON.parse(text)
}
