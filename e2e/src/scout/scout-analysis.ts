import {
  summarizeTrend,
  type RuntimeSnapshot,
  type TrendSummary,
} from '../support/resource-probe.js';

const MEBIBYTE = 1024 * 1024;

export type ScoutJourney = 'session' | 'review' | 'work';

export type ScoutCheckpoint = {
  journey: ScoutJourney;
  iteration: number;
  phase: 'warmup' | 'measure';
  active: RuntimeSnapshot;
  postGc: RuntimeSnapshot;
};

export type ScoutMetricSummary = {
  metric: string;
  unit: 'bytes' | 'count' | 'percent' | 'milliseconds' | 'seconds';
  analysisKind: 'post-gc-candidate' | 'observational';
  active: ScoutTrendSummary;
  postGc: ScoutTrendSummary;
  suspected: boolean;
};

export type SuspectedTrend = {
  journey: ScoutJourney;
  metric: string;
  trend: ScoutTrendSummary;
  reason: string;
};

export type ScoutTrendSummary = TrendSummary & {
  slopePerIteration: number;
  relativeNetChange: number;
};

type MetricDefinition = {
  name: string;
  unit: ScoutMetricSummary['unit'];
  minimumNetChange: number;
  leakSignal: boolean;
  analysisKind?: ScoutMetricSummary['analysisKind'];
  read: (snapshot: RuntimeSnapshot) => number;
};

function sumProcessMetric(
  snapshot: RuntimeSnapshot,
  kinds: ReadonlySet<string>,
  field: 'residentSetBytes' | 'cpuPercent'
): number {
  return snapshot.processTree
    .filter((process) => kinds.has(process.kind))
    .reduce((total, process) => total + process[field], 0);
}

function countProcesses(snapshot: RuntimeSnapshot, kinds?: ReadonlySet<string>): number {
  return kinds
    ? snapshot.processTree.filter((process) => kinds.has(process.kind)).length
    : snapshot.processTree.length;
}

const CLI_KINDS = new Set(['bundled-cli']);
const AGENT_KINDS = new Set(['agent-runtime']);
const RENDERER_KINDS = new Set(['renderer']);

const METRICS: readonly MetricDefinition[] = [
  {
    name: 'main.heapUsedBytes',
    unit: 'bytes',
    minimumNetChange: 4 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => snapshot.main.heapUsedBytes,
  },
  {
    name: 'main.privateBytes',
    unit: 'bytes',
    minimumNetChange: 16 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => snapshot.main.privateBytes ?? snapshot.main.residentSetBytes,
  },
  {
    name: 'main.residentSetBytes',
    unit: 'bytes',
    minimumNetChange: 16 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => snapshot.main.residentSetBytes,
  },
  {
    name: 'renderer.residentSetBytes',
    unit: 'bytes',
    minimumNetChange: 16 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => sumProcessMetric(snapshot, RENDERER_KINDS, 'residentSetBytes'),
  },
  {
    name: 'renderer.jsHeapUsedBytes',
    unit: 'bytes',
    minimumNetChange: 4 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => snapshot.renderer.jsHeapUsedBytes ?? 0,
  },
  {
    name: 'renderer.domNodes',
    unit: 'count',
    minimumNetChange: 100,
    leakSignal: true,
    read: (snapshot) => snapshot.renderer.domNodes,
  },
  {
    name: 'renderer.documents',
    unit: 'count',
    minimumNetChange: 1,
    leakSignal: true,
    read: (snapshot) => snapshot.renderer.documents,
  },
  {
    name: 'renderer.eventListeners',
    unit: 'count',
    minimumNetChange: 50,
    leakSignal: true,
    read: (snapshot) => snapshot.renderer.eventListeners,
  },
  {
    name: 'cli.residentSetBytes',
    unit: 'bytes',
    minimumNetChange: 8 * MEBIBYTE,
    leakSignal: false,
    analysisKind: 'observational',
    read: (snapshot) => sumProcessMetric(snapshot, CLI_KINDS, 'residentSetBytes'),
  },
  {
    name: 'cli.cpuPercent',
    unit: 'percent',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => sumProcessMetric(snapshot, CLI_KINDS, 'cpuPercent'),
  },
  {
    name: 'agent.residentSetBytes',
    unit: 'bytes',
    minimumNetChange: 8 * MEBIBYTE,
    leakSignal: true,
    read: (snapshot) => sumProcessMetric(snapshot, AGENT_KINDS, 'residentSetBytes'),
  },
  {
    name: 'agent.cpuPercent',
    unit: 'percent',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => sumProcessMetric(snapshot, AGENT_KINDS, 'cpuPercent'),
  },
  {
    name: 'process.count',
    unit: 'count',
    minimumNetChange: 1,
    leakSignal: true,
    read: (snapshot) => countProcesses(snapshot),
  },
  {
    name: 'agent.processCount',
    unit: 'count',
    minimumNetChange: 1,
    leakSignal: true,
    read: (snapshot) => countProcesses(snapshot, AGENT_KINDS),
  },
  {
    name: 'renderer.layoutCount',
    unit: 'count',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.layoutCount ?? 0,
  },
  {
    name: 'renderer.recalcStyleCount',
    unit: 'count',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.recalcStyleCount ?? 0,
  },
  {
    name: 'renderer.taskDurationSeconds',
    unit: 'seconds',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.taskDurationSeconds ?? 0,
  },
  {
    name: 'renderer.longTaskCount',
    unit: 'count',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.longTaskCount,
  },
  {
    name: 'renderer.longTaskDurationMs',
    unit: 'milliseconds',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.longTaskDurationMs,
  },
  {
    name: 'renderer.paintCount',
    unit: 'count',
    minimumNetChange: 0,
    leakSignal: false,
    read: (snapshot) => snapshot.renderer.paintCount,
  },
];

export function isSustainedPostGcGrowth(trend: TrendSummary, minimumNetChange: number): boolean {
  if (trend.samples < 4 || trend.first === null || trend.slopePerCheckpoint <= 0) return false;
  return trend.netChange >= minimumNetChange && trend.nonDecreasingDeltaRatio >= 0.75;
}

export function theilSenSlopeAtIterations(
  values: readonly number[],
  iterations: readonly number[]
): number {
  if (values.length !== iterations.length) {
    throw new Error('Scout values and iteration coordinates must have equal length');
  }
  const slopes: number[] = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const iterationDelta = iterations[right]! - iterations[left]!;
      if (iterationDelta > 0) {
        slopes.push((values[right]! - values[left]!) / iterationDelta);
      }
    }
  }
  if (slopes.length === 0) return 0;
  const sorted = [...slopes].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summarizeScoutTrend(
  values: readonly number[],
  iterations: readonly number[]
): ScoutTrendSummary {
  const trend = summarizeTrend(values);
  return {
    ...trend,
    slopePerIteration: theilSenSlopeAtIterations(values, iterations),
    relativeNetChange:
      trend.first && trend.first > 0 ? trend.netChange / trend.first : trend.netChange > 0 ? 1 : 0,
  };
}

export function analyzeScoutCheckpoints(checkpoints: readonly ScoutCheckpoint[]): {
  metrics: ScoutMetricSummary[];
  suspectedTrends: Omit<SuspectedTrend, 'journey'>[];
} {
  const measured = checkpoints.filter((checkpoint) => checkpoint.phase === 'measure');
  const iterations = measured.map((checkpoint) => checkpoint.iteration);
  const metrics = METRICS.map((definition): ScoutMetricSummary => {
    const active = summarizeScoutTrend(
      measured.map((checkpoint) => definition.read(checkpoint.active)),
      iterations
    );
    const postGc = summarizeScoutTrend(
      measured.map((checkpoint) => definition.read(checkpoint.postGc)),
      iterations
    );
    return {
      metric: definition.name,
      unit: definition.unit,
      analysisKind:
        definition.analysisKind ?? (definition.leakSignal ? 'post-gc-candidate' : 'observational'),
      active,
      postGc,
      suspected:
        definition.leakSignal && isSustainedPostGcGrowth(postGc, definition.minimumNetChange),
    };
  });
  return {
    metrics,
    suspectedTrends: metrics
      .filter((metric) => metric.suspected)
      .map((metric) => ({
        metric: metric.metric,
        trend: metric.postGc,
        reason: 'post-GC baseline rose consistently after warmup',
      })),
  };
}

export function ordinaryLeastSquaresSlope(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const centerX = (values.length - 1) / 2;
  const centerY = values.reduce((total, value) => total + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - centerX) * (values[index]! - centerY);
    denominator += (index - centerX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function buildAblationReport(checkpoints: readonly ScoutCheckpoint[]): object {
  const postGc = checkpoints.map((checkpoint) => checkpoint.postGc);
  const variants = [
    { name: 'raw-every-1', drop: 0, stride: 1 },
    { name: 'warmup-2-every-1', drop: 2, stride: 1 },
    { name: 'warmup-3-every-1', drop: 3, stride: 1 },
    { name: 'warmup-3-every-2', drop: 3, stride: 2 },
    { name: 'warmup-3-every-5', drop: 3, stride: 5 },
  ];
  return {
    variants: variants.map((variant) => ({
      ...variant,
      metrics: METRICS.filter((definition) => definition.minimumNetChange > 0).map((definition) => {
        const values = postGc
          .slice(variant.drop)
          .filter((_snapshot, index) => index % variant.stride === 0)
          .map(definition.read);
        return {
          metric: definition.name,
          samples: values.length,
          theilSenSlopePerIteration: summarizeTrend(values).slopePerCheckpoint / variant.stride,
          ordinaryLeastSquaresSlopePerIteration: ordinaryLeastSquaresSlope(values) / variant.stride,
          positiveDeltaRatio: summarizeTrend(values).positiveDeltaRatio,
          nonDecreasingDeltaRatio: summarizeTrend(values).nonDecreasingDeltaRatio,
        };
      }),
    })),
  };
}
