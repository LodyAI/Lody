import type { DevframeJsonRenderSpec } from '@devframes/json-render'
import type { DevbarRendererSample, DevbarSnapshot } from '@lody/shared/devbar'

const SPARKLINE_LEVELS = '▁▂▃▄▅▆▇█'
const MAX_TREND_POINTS = 60

function percent(value: number | null): string {
  return value == null ? 'Unavailable' : `${value.toFixed(1)}%`
}

function memory(value: number | null): string {
  return value == null ? 'Unavailable' : `${(value / 1024 / 1024).toFixed(0)} MiB`
}

function decimal(value: number | null, digits = 1): string {
  return value == null ? 'Unavailable' : value.toFixed(digits)
}

function mib(value: number | null): number | null {
  return value == null ? null : value / 1024 / 1024
}

function longTaskDuration(sample: DevbarRendererSample): number {
  return sample.longTasks.reduce((total, task) => total + task.durationMs, 0)
}

function sparkline(values: number[]): string {
  const points = values.slice(-MAX_TREND_POINTS).filter(Number.isFinite)
  if (points.length === 0) return 'Waiting for samples…'
  const minimum = Math.min(...points)
  const maximum = Math.max(...points)
  if (minimum === maximum) return '▄'.repeat(points.length)
  return points
    .map((value) => {
      const index = Math.round(
        ((value - minimum) / (maximum - minimum)) * (SPARKLINE_LEVELS.length - 1)
      )
      return SPARKLINE_LEVELS[index]
    })
    .join('')
}

function range(values: number[], format: (value: number) => string): string {
  const points = values.filter(Number.isFinite)
  if (points.length === 0) return 'Unavailable'
  return `${format(Math.min(...points))} – ${format(Math.max(...points))}`
}

function trendRow(signal: string, values: Array<number | null>, format: (value: number) => string) {
  const available = values.filter(
    (value): value is number => value != null && Number.isFinite(value)
  )
  return {
    signal,
    trend: sparkline(available),
    current: available.length === 0 ? 'Unavailable' : format(available.at(-1)!),
    range: range(available, format)
  }
}

export function createDevbarViewState(snapshot: DevbarSnapshot) {
  const latest = snapshot.latest
  const recentBlockedMs = latest ? longTaskDuration(latest) : null
  const responsive =
    latest != null &&
    (latest.fps == null || latest.fps >= 50) &&
    (recentBlockedMs == null || recentBlockedMs < 50)
  const fpsValues = snapshot.samples.map((sample) => sample.fps)
  const cpuValues = snapshot.samples.map((sample) => sample.cpu)
  const heapValues = snapshot.samples.map((sample) => mib(sample.heapBytes))
  const rssValues = snapshot.samples.map((sample) => mib(sample.rssBytes))
  const blockedValues = snapshot.samples.map(longTaskDuration)
  return {
    statusText: latest ? (responsive ? 'Responsive' : 'Needs attention') : 'Waiting',
    route: latest?.route ?? 'Waiting for the Lody renderer to publish its first sample.',
    fps: latest?.fps ?? 0,
    headline: {
      fps: latest?.fps == null ? '—' : latest.fps.toFixed(0),
      cpu: percent(latest?.cpu ?? null),
      heap: memory(latest?.heapBytes ?? null),
      blocked: recentBlockedMs == null ? '—' : `${recentBlockedMs.toFixed(0)} ms`
    },
    trends: [
      trendRow('FPS', fpsValues, (value) => `${value.toFixed(0)}`),
      trendRow('Electron CPU', cpuValues, (value) => `${value.toFixed(1)}%`),
      trendRow('JS heap', heapValues, (value) => `${value.toFixed(0)} MiB`),
      trendRow('Resident memory', rssValues, (value) => `${value.toFixed(0)} MiB`),
      trendRow('Blocked / sample', blockedValues, (value) => `${value.toFixed(0)} ms`)
    ],
    metrics: {
      'Frame rate': latest?.fps == null ? 'Unavailable' : `${latest.fps.toFixed(0)} FPS`,
      'Electron CPU': percent(latest?.cpu ?? null),
      'Resident memory': memory(latest?.rssBytes ?? null),
      'JavaScript heap': memory(latest?.heapBytes ?? null),
      'Layout shift (CLS)': decimal(latest?.cls ?? null, 4),
      'GPU process CPU': percent(latest?.gpuCpu ?? null),
      'GPU process RSS': memory(latest?.gpuRssBytes ?? null)
    },
    blocking: {
      'Samples retained': snapshot.summary.sampleCount,
      'Long tasks observed': snapshot.summary.longTaskCount,
      'Total blocked time': `${snapshot.summary.totalLongTaskDurationMs.toFixed(1)} ms`,
      'Worst long task': `${snapshot.summary.maxLongTaskDurationMs.toFixed(1)} ms`
    },
    longTasks: snapshot.longTasks
      .slice(-30)
      .reverse()
      .map((task) => ({
        observed: new Date(task.observedAtMs).toISOString().slice(11, 19),
        duration: `${task.durationMs.toFixed(1)} ms`,
        attribution: task.attribution?.containerName || task.attribution?.containerType || task.name
      })),
    updatedAt:
      snapshot.updatedAtMs == null
        ? 'No renderer sample received yet'
        : new Date(snapshot.updatedAtMs).toISOString()
  }
}

export const DEVBAR_VIEW_SPEC: DevframeJsonRenderSpec = {
  root: 'root',
  elements: {
    root: {
      type: 'Stack',
      props: { gap: 14 },
      children: ['header', 'route', 'overview', 'trendsCard', 'details', 'tasksCard', 'note']
    },
    header: {
      type: 'Stack',
      props: { direction: 'row', gap: 10, align: 'center', justify: 'between' },
      children: ['identity', 'statusGroup']
    },
    identity: {
      type: 'Stack',
      props: { direction: 'row', gap: 8, align: 'center' },
      children: ['icon', 'title']
    },
    icon: {
      type: 'Icon',
      props: { name: 'ph:activity-duotone', size: 26 },
      children: []
    },
    title: {
      type: 'Text',
      props: { text: 'Lody Devbar', variant: 'heading' },
      children: []
    },
    statusGroup: {
      type: 'Stack',
      props: { direction: 'row', gap: 6 },
      children: ['statusWaiting', 'statusResponsive', 'statusAttention']
    },
    statusWaiting: {
      type: 'Badge',
      props: { text: 'Waiting', variant: 'default' },
      children: [],
      visible: { $state: '/dashboard/statusText', eq: 'Waiting' }
    },
    statusResponsive: {
      type: 'Badge',
      props: { text: 'Responsive', variant: 'success' },
      children: [],
      visible: { $state: '/dashboard/statusText', eq: 'Responsive' }
    },
    statusAttention: {
      type: 'Badge',
      props: { text: 'Needs attention', variant: 'warning' },
      children: [],
      visible: { $state: '/dashboard/statusText', eq: 'Needs attention' }
    },
    route: {
      type: 'Text',
      props: { text: { $state: '/dashboard/route' }, variant: 'code', color: 'muted' },
      children: []
    },
    overview: {
      type: 'Stack',
      props: { direction: 'row', gap: 10, wrap: true, align: 'stretch' },
      children: ['fpsCard', 'cpuCard', 'heapCard', 'blockedCard']
    },
    fpsCard: {
      type: 'Card',
      props: { title: 'Frame rate' },
      children: ['fpsValue', 'fpsTarget']
    },
    fpsValue: {
      type: 'Text',
      props: { text: { $state: '/dashboard/headline/fps' }, variant: 'heading' },
      children: []
    },
    fpsTarget: {
      type: 'Progress',
      props: { label: '60 FPS target', value: { $state: '/dashboard/fps' }, max: 60 },
      children: []
    },
    cpuCard: {
      type: 'Card',
      props: { title: 'Electron CPU' },
      children: ['cpuValue']
    },
    cpuValue: {
      type: 'Text',
      props: { text: { $state: '/dashboard/headline/cpu' }, variant: 'heading' },
      children: []
    },
    heapCard: {
      type: 'Card',
      props: { title: 'JavaScript heap' },
      children: ['heapValue']
    },
    heapValue: {
      type: 'Text',
      props: { text: { $state: '/dashboard/headline/heap' }, variant: 'heading' },
      children: []
    },
    blockedCard: {
      type: 'Card',
      props: { title: 'Blocked this sample' },
      children: ['blockedValue']
    },
    blockedValue: {
      type: 'Text',
      props: { text: { $state: '/dashboard/headline/blocked' }, variant: 'heading' },
      children: []
    },
    trendsCard: {
      type: 'Card',
      props: { title: 'Live trends · last 60 samples' },
      children: ['trends']
    },
    trends: {
      type: 'DataTable',
      props: {
        columns: [
          { key: 'signal', label: 'Signal' },
          { key: 'trend', label: 'Trend' },
          { key: 'current', label: 'Current' },
          { key: 'range', label: 'Range' }
        ],
        rows: { $state: '/dashboard/trends' }
      },
      children: []
    },
    details: {
      type: 'Stack',
      props: { direction: 'row', gap: 12, wrap: true, align: 'start' },
      children: ['metricsCard', 'blockingCard']
    },
    metricsCard: {
      type: 'Card',
      props: { title: 'Current sample', collapsible: true },
      children: ['metrics']
    },
    metrics: {
      type: 'KeyValueTable',
      props: { data: { $state: '/dashboard/metrics' } },
      children: []
    },
    blockingCard: {
      type: 'Card',
      props: { title: 'Blocking summary', collapsible: true },
      children: ['blocking']
    },
    blocking: {
      type: 'KeyValueTable',
      props: { data: { $state: '/dashboard/blocking' } },
      children: []
    },
    tasksCard: {
      type: 'Card',
      props: { title: 'Recent Long Tasks', collapsible: true },
      children: ['tasks']
    },
    tasks: {
      type: 'DataTable',
      props: {
        columns: [
          { key: 'observed', label: 'Observed' },
          { key: 'duration', label: 'Duration' },
          { key: 'attribution', label: 'Attribution' }
        ],
        rows: { $state: '/dashboard/longTasks' },
        height: 240
      },
      children: []
    },
    note: {
      type: 'Stack',
      props: { gap: 6 },
      children: ['updatedAt', 'explanation']
    },
    updatedAt: {
      type: 'Text',
      props: { text: { $state: '/dashboard/updatedAt' }, variant: 'caption', color: 'faint' },
      children: []
    },
    explanation: {
      type: 'Text',
      props: {
        text: 'Measurements stay in memory. Long Tasks identify blocking windows of 50 ms or more but do not include JavaScript stacks.',
        variant: 'caption',
        color: 'faint'
      },
      children: []
    }
  },
  state: {
    dashboard: createDevbarViewState({
      updatedAtMs: null,
      latest: null,
      samples: [],
      longTasks: [],
      summary: {
        sampleCount: 0,
        longTaskCount: 0,
        totalLongTaskDurationMs: 0,
        maxLongTaskDurationMs: 0
      }
    })
  }
}
