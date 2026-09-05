import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

const execFileAsync = promisify(execFile);

export type ProcessKind =
  | 'electron-main'
  | 'renderer'
  | 'gpu'
  | 'utility'
  | 'bundled-cli'
  | 'agent-runtime'
  | 'child';

export type ProcessTreeMetric = {
  pid: number;
  parentPid: number;
  kind: ProcessKind;
  cpuPercent: number;
  residentSetBytes: number;
};

export type RuntimeSnapshot = {
  capturedAt: string;
  kind: 'ambient' | 'post-gc';
  main: {
    heapUsedBytes: number;
    heapTotalBytes: number;
    privateBytes: number | null;
    residentSetBytes: number;
  };
  electronProcesses: Array<{
    pid: number;
    type: string;
    cpuPercent: number;
    workingSetBytes: number;
    peakWorkingSetBytes: number;
  }>;
  processTree: ProcessTreeMetric[];
  renderer: {
    domNodes: number;
    documents: number;
    eventListeners: number;
    jsHeapUsedBytes: number | null;
    jsHeapTotalBytes: number | null;
    layoutCount: number | null;
    recalcStyleCount: number | null;
    taskDurationSeconds: number | null;
    longTaskCount: number;
    longTaskDurationMs: number;
    paintCount: number;
  };
};

type CdpMetric = { name: string; value: number };
type ProcessTableRow = Omit<ProcessTreeMetric, 'kind'> & { command: string };

function metricValue(metrics: readonly CdpMetric[], name: string): number | null {
  return metrics.find((metric) => metric.name === name)?.value ?? null;
}

export function parseProcessTable(output: string): ProcessTableRow[] {
  return output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      residentSetBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      command: match[5]!,
    }));
}

function classifyProcess(command: string, pid: number, rootPid: number): ProcessKind {
  if (pid === rootPid) return 'electron-main';
  if (/resources[/\\]cli[/\\]index\.js/u.test(command)) return 'bundled-cli';
  if (/(?:-acp\.js\b|scripted-acp\.mjs\b|\bapp-server\b|code-mode-host\b)/u.test(command)) {
    return 'agent-runtime';
  }
  if (/--type=renderer\b/u.test(command)) return 'renderer';
  if (/--type=gpu-process\b/u.test(command)) return 'gpu';
  if (/--type=utility\b/u.test(command)) return 'utility';
  return 'child';
}

export function selectProcessTree(
  rows: readonly ProcessTableRow[],
  rootPid: number
): ProcessTreeMetric[] {
  const selectedPids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selectedPids.has(row.pid) && selectedPids.has(row.parentPid)) {
        selectedPids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => selectedPids.has(row.pid))
    .map(({ command, ...row }) => ({
      ...row,
      kind: classifyProcess(command, row.pid, rootPid),
    }))
    .sort((left, right) => left.pid - right.pid);
}

async function collectProcessTree(rootPid: number): Promise<ProcessTreeMetric[]> {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command=']);
  return selectProcessTree(parseProcessTable(stdout), rootPid);
}

export async function collectRuntimeSnapshot(
  electronApp: ElectronApplication,
  page: Page,
  kind: RuntimeSnapshot['kind'] = 'ambient',
  performanceSession?: CDPSession,
  paintCount?: number
): Promise<RuntimeSnapshot> {
  const rootPid = electronApp.process().pid;
  if (rootPid === undefined) throw new Error('Electron main process has no pid');
  const main = await electronApp.evaluate(async ({ app }) => {
    const memory = process.memoryUsage();
    const processMemory = await process.getProcessMemoryInfo();
    return {
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      privateBytes: typeof processMemory.private === 'number' ? processMemory.private * 1024 : null,
      residentSetBytes: memory.rss,
      processes: app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpuPercent: metric.cpu.percentCPUUsage,
        workingSetBytes: metric.memory.workingSetSize * 1024,
        peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
      })),
    };
  });

  const cdp = performanceSession ?? (await page.context().newCDPSession(page));
  if (!performanceSession) await cdp.send('Performance.enable');
  const [dom, performanceMetrics, heap, processTree, timeline] = await Promise.all([
    cdp.send('Memory.getDOMCounters') as Promise<{
      documents: number;
      nodes: number;
      jsEventListeners: number;
    }>,
    cdp.send('Performance.getMetrics') as Promise<{ metrics: CdpMetric[] }>,
    cdp.send('Runtime.getHeapUsage') as Promise<{ usedSize: number; totalSize: number }>,
    collectProcessTree(rootPid),
    page.evaluate(() => ({
      longTaskCount: window.__LODY_E2E_PERFORMANCE__?.longTaskCount ?? 0,
      longTaskDurationMs: window.__LODY_E2E_PERFORMANCE__?.longTaskDurationMs ?? 0,
      paintCount: performance.getEntriesByType('paint').length,
    })),
  ]);
  if (!performanceSession) await cdp.detach();

  return {
    capturedAt: new Date().toISOString(),
    kind,
    main: {
      heapUsedBytes: main.heapUsedBytes,
      heapTotalBytes: main.heapTotalBytes,
      privateBytes: main.privateBytes,
      residentSetBytes: main.residentSetBytes,
    },
    electronProcesses: main.processes,
    processTree,
    renderer: {
      domNodes: dom.nodes,
      documents: dom.documents,
      eventListeners: dom.jsEventListeners,
      jsHeapUsedBytes: heap.usedSize,
      jsHeapTotalBytes: heap.totalSize,
      layoutCount: metricValue(performanceMetrics.metrics, 'LayoutCount'),
      recalcStyleCount: metricValue(performanceMetrics.metrics, 'RecalcStyleCount'),
      taskDurationSeconds: metricValue(performanceMetrics.metrics, 'TaskDuration'),
      longTaskCount: timeline.longTaskCount,
      longTaskDurationMs: timeline.longTaskDurationMs,
      paintCount: paintCount ?? timeline.paintCount,
    },
  };
}

export async function collectPostGcRuntimeSnapshot(
  electronApp: ElectronApplication,
  page: Page,
  performanceSession?: CDPSession,
  paintCount?: number
): Promise<RuntimeSnapshot> {
  await electronApp.evaluate(() => global.gc?.());
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
  } finally {
    await cdp.detach();
  }
  await page.evaluate(
    async () =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  return await collectRuntimeSnapshot(electronApp, page, 'post-gc', performanceSession, paintCount);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function theilSenSlope(values: readonly number[]): number {
  const slopes: number[] = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      slopes.push((values[right]! - values[left]!) / (right - left));
    }
  }
  return median(slopes);
}

export type TrendSummary = {
  samples: number;
  first: number | null;
  last: number | null;
  netChange: number;
  slopePerCheckpoint: number;
  positiveDeltaRatio: number;
  nonDecreasingDeltaRatio: number;
};

export function summarizeTrend(values: readonly number[]): TrendSummary {
  if (values.length === 0) {
    return {
      samples: 0,
      first: null,
      last: null,
      netChange: 0,
      slopePerCheckpoint: 0,
      positiveDeltaRatio: 0,
      nonDecreasingDeltaRatio: 0,
    };
  }
  let positiveDeltas = 0;
  let nonDecreasingDeltas = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! > values[index - 1]!) positiveDeltas += 1;
    if (values[index]! >= values[index - 1]!) nonDecreasingDeltas += 1;
  }
  return {
    samples: values.length,
    first: values[0]!,
    last: values.at(-1)!,
    netChange: values.at(-1)! - values[0]!,
    slopePerCheckpoint: theilSenSlope(values),
    positiveDeltaRatio: values.length < 2 ? 0 : positiveDeltas / (values.length - 1),
    nonDecreasingDeltaRatio: values.length < 2 ? 0 : nonDecreasingDeltas / (values.length - 1),
  };
}
