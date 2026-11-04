// Stops Lody when the disk holding its data is full. A storage write failure
// alone is not enough: IndexedDB and SQLite fail for other reasons too, so the
// guard blocks only after a failure AND a check that finds a volume holding Lody
// data short of space. Once blocked it stays blocked for the process lifetime;
// the way out is a relaunch after the user frees space, or quitting. Background
// agents keep running until the user quits. Decision:
// .agents/notes/proposed/feature/2026-10-22-desktop-disk-full-guard.md
import type {
  ElectronStorageGuardRelaunchOutcome,
  ElectronStorageGuardSource,
  ElectronStorageGuardState,
  ElectronStorageGuardVolume
} from '@lody/shared/electron-ipc'

const GIB = 1024 ** 3
const MIN_REQUIRED_FREE_BYTES = 5 * GIB
const MAX_REQUIRED_FREE_BYTES = 20 * GIB
const REQUIRED_FREE_RATIO = 0.02
/** Free space above the requirement needed to resume, so Lody does not reopen at the edge. */
const RESUME_SLACK_BYTES = 1 * GIB
/** Write failures arrive in bursts; one disk check answers a burst. */
const MIN_CHECK_INTERVAL_MS = 10_000

export type VolumeSpace = { freeBytes: number; totalBytes: number }
type VolumeReading = VolumeSpace & { required: number }

export type StorageGuardDeps = {
  /** Directories holding Lody data: the renderer's profile and the CLI data dir. */
  dataDirs: readonly string[]
  /** Free space available to this user on the volume holding `path`. */
  readVolume: (path: string) => Promise<VolumeSpace>
  broadcast: (state: ElectronStorageGuardState) => void
  quitAndRelaunch: () => Promise<'quitting' | 'cancelled'>
  quit: () => void
  log: (level: 'info' | 'warn', message: string) => void
  now?: () => number
}

/** 2% of the volume, kept within 5–20 GiB. */
export function requiredFreeBytes(totalBytes: number): number {
  return Math.min(
    MAX_REQUIRED_FREE_BYTES,
    Math.max(MIN_REQUIRED_FREE_BYTES, Math.round(totalBytes * REQUIRED_FREE_RATIO))
  )
}

export function createStorageGuard(deps: StorageGuardDeps) {
  const now = deps.now ?? (() => Date.now())
  let state: ElectronStorageGuardState = { blocked: false }
  let checking: Promise<void> | null = null
  let lastCheckAtMs = Number.NEGATIVE_INFINITY

  /** The volume with the least headroom; `undefined` when no directory could be read. */
  const readMostConstrained = async (requireAll = false): Promise<VolumeReading | undefined> => {
    let worst: VolumeReading | undefined
    for (const dir of deps.dataDirs) {
      let space: VolumeSpace
      try {
        space = await deps.readVolume(dir)
      } catch (error) {
        deps.log('warn', `could not read free space: ${String(error)}`)
        if (requireAll) return undefined
        continue
      }
      const reading = { ...space, required: requiredFreeBytes(space.totalBytes) }
      if (!worst || reading.freeBytes - reading.required < worst.freeBytes - worst.required) {
        worst = reading
      }
    }
    return worst
  }

  const toVolume = (reading: VolumeReading): ElectronStorageGuardVolume => ({
    freeBytes: reading.freeBytes,
    totalBytes: reading.totalBytes,
    resumeFreeBytes: reading.required + RESUME_SLACK_BYTES
  })

  const publish = (next: ElectronStorageGuardState) => {
    state = next
    deps.broadcast(state)
  }

  const check = async (source: ElectronStorageGuardSource) => {
    const reading = await readMostConstrained()
    if (!reading || state.blocked) return
    if (reading.freeBytes >= reading.required) {
      deps.log(
        'info',
        `${source} storage write failed with ${reading.freeBytes} bytes free; not blocking`
      )
      return
    }
    deps.log(
      'warn',
      `${source} storage write failed with ${reading.freeBytes} bytes free; blocking`
    )
    publish({ blocked: true, source, volume: toVolume(reading) })
  }

  return {
    getState: (): ElectronStorageGuardState => state,

    /** A Lody process failed a storage write; check whether the disk is the reason. */
    reportWriteFailure(source: ElectronStorageGuardSource): Promise<void> {
      if (state.blocked) return Promise.resolve()
      if (checking) return checking
      if (now() - lastCheckAtMs < MIN_CHECK_INTERVAL_MS) return Promise.resolve()
      lastCheckAtMs = now()
      checking = check(source).finally(() => {
        checking = null
      })
      return checking
    },

    /**
     * Relaunches once the volume has room again. A relaunch, not an unblock: a
     * renderer whose storage already failed keeps a broken connection until it
     * reloads, and a fresh process reopens every store.
     */
    async relaunchIfSpaceFreed(): Promise<ElectronStorageGuardRelaunchOutcome> {
      const reading = await readMostConstrained(true)
      if (!reading) return 'check_failed'
      if (reading.freeBytes < reading.required + RESUME_SLACK_BYTES) {
        publish({ ...state, volume: toVolume(reading) })
        return 'still_low'
      }
      return await deps.quitAndRelaunch()
    },

    quit(): void {
      deps.quit()
    }
  }
}

export type StorageGuard = ReturnType<typeof createStorageGuard>
