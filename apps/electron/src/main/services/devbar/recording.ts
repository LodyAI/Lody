import type { DevbarLongTask, DevbarRendererSample, DevbarSnapshot } from '@lody/shared/devbar'

const MAX_SAMPLES = 120
const MAX_LONG_TASKS = 100

export class DevbarRecording {
  private readonly samples: DevbarRendererSample[] = []
  private readonly longTasks: DevbarLongTask[] = []
  private totalLongTaskDurationMs = 0
  private longTaskCount = 0
  private maxLongTaskDurationMs = 0

  record(sample: DevbarRendererSample): DevbarSnapshot {
    this.samples.push(sample)
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)

    for (const task of sample.longTasks) {
      this.longTasks.push(task)
      this.longTaskCount++
      this.totalLongTaskDurationMs += task.durationMs
      this.maxLongTaskDurationMs = Math.max(this.maxLongTaskDurationMs, task.durationMs)
    }
    if (this.longTasks.length > MAX_LONG_TASKS) {
      this.longTasks.splice(0, this.longTasks.length - MAX_LONG_TASKS)
    }
    return this.snapshot()
  }

  snapshot(): DevbarSnapshot {
    return {
      updatedAtMs: this.samples.at(-1)?.recordedAtMs ?? null,
      latest: this.samples.at(-1) ?? null,
      samples: [...this.samples],
      longTasks: [...this.longTasks],
      summary: {
        sampleCount: this.samples.length,
        longTaskCount: this.longTaskCount,
        totalLongTaskDurationMs: this.totalLongTaskDurationMs,
        maxLongTaskDurationMs: this.maxLongTaskDurationMs
      }
    }
  }
}
