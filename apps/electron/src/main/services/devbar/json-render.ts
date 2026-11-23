import type { DevframeJsonRenderSpec } from '@devframes/json-render'
import type { DevbarRendererSample, DevbarSnapshot } from '@lody/shared/devbar'

function percent(value: number | null): string {
  return value == null ? 'Unavailable' : `${value.toFixed(1)}%`
}

function memory(value: number | null, precise = true): string {
  return value == null
    ? 'Unavailable'
    : `${precise ? '' : '~'}${(value / 1024 / 1024).toFixed(0)} MiB`
}

function decimal(value: number | null, digits = 1): string {
  return value == null ? 'Unavailable' : value.toFixed(digits)
}

function longTaskDuration(sample: DevbarRendererSample): number {
  return sample.longTasks.reduce((total, task) => total + task.durationMs, 0)
}

export function createDevbarViewState(snapshot: DevbarSnapshot) {
  const latest = snapshot.latest
  const recentBlockedMs = latest ? longTaskDuration(latest) : null
  const responsive =
    latest != null &&
    (latest.fps == null || latest.fps >= 50) &&
    (recentBlockedMs == null || recentBlockedMs < 50) &&
    (latest.cls == null || latest.cls < 0.1)
  return {
    statusText: latest ? (responsive ? 'Responsive' : 'Needs attention') : 'Waiting',
    route: latest?.route ?? 'Waiting for the Lody renderer to publish its first sample.',
    fps: latest?.fps ?? 0,
    headline: {
      fps: latest?.fps == null ? '—' : latest.fps.toFixed(0),
      cpu: percent(latest?.cpu ?? null),
      heap: memory(latest?.heapBytes ?? null, latest?.heapPrecise ?? true),
      blocked: recentBlockedMs == null ? '—' : `${recentBlockedMs.toFixed(0)} ms`
    },
    metrics: {
      'Frame rate': latest?.fps == null ? 'Unavailable' : `${latest.fps.toFixed(0)} FPS`,
      'Electron CPU': percent(latest?.cpu ?? null),
      'Resident memory': memory(latest?.rssBytes ?? null),
      'JavaScript heap': memory(latest?.heapBytes ?? null, latest?.heapPrecise ?? true),
      'Layout shift (CLS)': decimal(latest?.cls ?? null, 4),
      'GPU process CPU': percent(latest?.gpuCpu ?? null),
      'GPU process RSS': memory(latest?.gpuRssBytes ?? null),
      'Warm pool': latest?.warmPool
        ? `${latest.warmPool.phase} (${latest.warmPool.spareCount} spare)`
        : 'Unavailable',
      'Warm spare RSS': memory(latest?.warmPool?.spareRssBytes ?? null)
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
      children: ['header', 'route', 'overview', 'details', 'tasksCard', 'note']
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
        text: 'Measurements stay in memory. A ~ heap value is Chromium’s bucketed estimate when Devbar starts after launch. Long Tasks identify blocking windows of 50 ms or more but do not include JavaScript stacks.',
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
