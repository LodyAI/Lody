import { z } from 'zod';

const finiteNonNegativeNumber = z.number().finite().nonnegative();
const nullableMetric = finiteNonNegativeNumber.nullable();

export const DevbarWarmPoolSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(['disabled', 'idle', 'warming', 'ready']),
  spareRssBytes: nullableMetric,
  spareCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
});

export type DevbarWarmPool = z.infer<typeof DevbarWarmPoolSchema>;

export const DevbarLongTaskSchema = z.object({
  observedAtMs: finiteNonNegativeNumber,
  startTimeMs: finiteNonNegativeNumber,
  durationMs: finiteNonNegativeNumber,
  name: z.string().max(128),
  attribution: z
    .object({
      containerType: z.string().max(128),
      containerName: z.string().max(512),
      containerId: z.string().max(512),
      containerSrc: z.string().max(2048),
    })
    .nullable(),
});

export type DevbarLongTask = z.infer<typeof DevbarLongTaskSchema>;

export const DevbarRendererSampleSchema = z.object({
  recordedAtMs: finiteNonNegativeNumber,
  route: z.string().max(2048),
  fps: nullableMetric,
  cls: nullableMetric,
  heapBytes: nullableMetric,
  heapPrecise: z.boolean(),
  cpu: nullableMetric,
  rssBytes: nullableMetric,
  gpuCpu: nullableMetric,
  gpuRssBytes: nullableMetric,
  warmPool: DevbarWarmPoolSchema.optional(),
  longTasks: z.array(DevbarLongTaskSchema).max(50),
});

export type DevbarRendererSample = z.infer<typeof DevbarRendererSampleSchema>;

export const DevbarSnapshotSchema = z.object({
  updatedAtMs: finiteNonNegativeNumber.nullable(),
  latest: DevbarRendererSampleSchema.nullable(),
  samples: z.array(DevbarRendererSampleSchema),
  longTasks: z.array(DevbarLongTaskSchema),
  summary: z.object({
    sampleCount: z.number().int().nonnegative(),
    longTaskCount: z.number().int().nonnegative(),
    totalLongTaskDurationMs: finiteNonNegativeNumber,
    maxLongTaskDurationMs: finiteNonNegativeNumber,
  }),
});

export type DevbarSnapshot = z.infer<typeof DevbarSnapshotSchema>;
