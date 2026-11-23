import type { DevbarLongTask } from '@lody/shared/devbar'

export interface LongTaskEntryLike {
  startTime: number
  duration: number
  name: string
  attribution?: readonly {
    containerType?: unknown
    containerName?: unknown
    containerId?: unknown
    containerSrc?: unknown
  }[]
}

export interface LongTaskBuffer {
  record: (entry: LongTaskEntryLike, timeOrigin: number) => DevbarLongTask
  recent: () => DevbarLongTask[]
  drain: () => DevbarLongTask[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createLongTaskBuffer(limit = 50): LongTaskBuffer {
  const recent: DevbarLongTask[] = []
  const pending: DevbarLongTask[] = []

  return {
    record(entry: LongTaskEntryLike, timeOrigin: number) {
      const source = entry.attribution?.[0]
      const attribution = source
        ? {
            containerType: text(source.containerType),
            containerName: text(source.containerName),
            containerId: text(source.containerId),
            containerSrc: text(source.containerSrc)
          }
        : null
      const task: DevbarLongTask = {
        observedAtMs: timeOrigin + entry.startTime,
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
        name: entry.name,
        attribution
      }
      recent.push(task)
      pending.push(task)
      if (recent.length > limit) recent.splice(0, recent.length - limit)
      if (pending.length > limit) pending.splice(0, pending.length - limit)
      return task
    },
    recent: () => [...recent],
    drain() {
      return pending.splice(0, pending.length)
    }
  }
}
