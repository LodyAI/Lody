import type { ProcessMetric } from 'electron'

export function isDevbarEnabled(value: string | undefined) {
  return value === 'true'
}

export function summarizeDevbarMetrics(metrics: ProcessMetric[], cpuReady: boolean) {
  const gpu = metrics.filter((metric) => metric.type === 'GPU')
  const cpu = (rows: ProcessMetric[]) =>
    cpuReady && rows.length > 0
      ? rows.reduce((total, row) => total + row.cpu.percentCPUUsage, 0)
      : null
  const rss = (rows: ProcessMetric[]) =>
    rows.length > 0 && rows.every((row) => Number.isFinite(row.memory?.workingSetSize))
      ? rows.reduce((total, row) => total + row.memory.workingSetSize * 1024, 0)
      : null
  return { cpu: cpu(metrics), rss: rss(metrics), gpuCpu: cpu(gpu), gpuRss: rss(gpu) }
}
