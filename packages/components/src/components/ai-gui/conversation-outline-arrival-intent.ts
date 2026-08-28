export interface ArrivalIntentPoint {
  x: number;
  y: number;
  /** Monotonic milliseconds, normally from `performance.now()`. */
  time: number;
}

export interface ArrivalIntentRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ArrivalIntentConfig {
  /** Samples older than this do not describe the current gesture. */
  sampleWindowMs: number;
  /** A pause longer than this starts a new gesture. */
  resetAfterMs: number;
  minSamples: number;
  /** Only arm intent close enough that the target is plausibly the destination. */
  maxDistancePx: number;
  minApproachDistancePx: number;
  minShrinkingSegmentRatio: number;
  recentShrinkingSegmentCount: number;
  minHeadingCosine: number;
  minEarlySpeedPxPerMs: number;
  minRecentSpeedPxPerMs: number;
  maxRecentSpeedPxPerMs: number;
  maxBrakingRatio: number;
  trajectoryHorizonMs: number;
  maxTimeToContactMs: number;
  predictionTtlMs: number;
}

export const DEFAULT_ARRIVAL_INTENT_CONFIG: Readonly<ArrivalIntentConfig> = {
  sampleWindowMs: 180,
  resetAfterMs: 100,
  minSamples: 5,
  maxDistancePx: 180,
  minApproachDistancePx: 24,
  minShrinkingSegmentRatio: 0.75,
  recentShrinkingSegmentCount: 3,
  minHeadingCosine: 0.88,
  minEarlySpeedPxPerMs: 0.35,
  minRecentSpeedPxPerMs: 0.08,
  maxRecentSpeedPxPerMs: 1.2,
  maxBrakingRatio: 0.78,
  trajectoryHorizonMs: 220,
  maxTimeToContactMs: 260,
  predictionTtlMs: 160,
};

export interface ArrivalIntentChecks {
  outsideTarget: boolean;
  enoughSamples: boolean;
  withinDistance: boolean;
  madeApproachProgress: boolean;
  distanceMostlyShrinking: boolean;
  distanceRecentlyShrinking: boolean;
  headingTowardTarget: boolean;
  earlySpeedHighEnough: boolean;
  recentSpeedInRange: boolean;
  braking: boolean;
  projectsToTarget: boolean;
  contactSoon: boolean;
}

export interface ArrivalIntentMetrics {
  sampleCount: number;
  distancePx: number | null;
  approachDistancePx: number | null;
  shrinkingSegmentRatio: number | null;
  headingCosine: number | null;
  earlySpeedPxPerMs: number | null;
  recentSpeedPxPerMs: number | null;
  brakingRatio: number | null;
  approachSpeedPxPerMs: number | null;
  timeToContactMs: number | null;
  projectedX: number | null;
  projectedY: number | null;
}

export interface ArrivalIntentEvaluation {
  qualifies: boolean;
  checks: ArrivalIntentChecks;
  metrics: ArrivalIntentMetrics;
}

export interface ArrivalIntentUpdate {
  evaluation: ArrivalIntentEvaluation;
  predictionActive: boolean;
  predictionActivated: boolean;
  predictedUntil: number | null;
}

const EMPTY_CHECKS: ArrivalIntentChecks = {
  outsideTarget: false,
  enoughSamples: false,
  withinDistance: false,
  madeApproachProgress: false,
  distanceMostlyShrinking: false,
  distanceRecentlyShrinking: false,
  headingTowardTarget: false,
  earlySpeedHighEnough: false,
  recentSpeedInRange: false,
  braking: false,
  projectsToTarget: false,
  contactSoon: false,
};

const emptyMetrics = (sampleCount: number): ArrivalIntentMetrics => ({
  sampleCount,
  distancePx: null,
  approachDistancePx: null,
  shrinkingSegmentRatio: null,
  headingCosine: null,
  earlySpeedPxPerMs: null,
  recentSpeedPxPerMs: null,
  brakingRatio: null,
  approachSpeedPxPerMs: null,
  timeToContactMs: null,
  projectedX: null,
  projectedY: null,
});

export const EMPTY_ARRIVAL_INTENT_EVALUATION: ArrivalIntentEvaluation = {
  qualifies: false,
  checks: EMPTY_CHECKS,
  metrics: emptyMetrics(0),
};

const isFinitePoint = (point: ArrivalIntentPoint): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.time);

const isValidRect = (rect: ArrivalIntentRect): boolean =>
  Number.isFinite(rect.left) &&
  Number.isFinite(rect.top) &&
  Number.isFinite(rect.right) &&
  Number.isFinite(rect.bottom) &&
  rect.right > rect.left &&
  rect.bottom > rect.top;

const pointInsideRect = (point: ArrivalIntentPoint, rect: ArrivalIntentRect): boolean =>
  point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;

const nearestPointInRect = (
  point: ArrivalIntentPoint,
  rect: ArrivalIntentRect
): { x: number; y: number } => ({
  x: Math.max(rect.left, Math.min(point.x, rect.right)),
  y: Math.max(rect.top, Math.min(point.y, rect.bottom)),
});

const distanceToRect = (point: ArrivalIntentPoint, rect: ArrivalIntentRect): number => {
  const nearest = nearestPointInRect(point, rect);
  return Math.hypot(nearest.x - point.x, nearest.y - point.y);
};

/** Liang-Barsky clipping against an axis-aligned rectangle. */
const segmentIntersectsRect = (
  start: ArrivalIntentPoint,
  end: { x: number; y: number },
  rect: ArrivalIntentRect
): boolean => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let near = 0;
  let far = 1;

  const clip = (origin: number, delta: number, min: number, max: number): boolean => {
    if (delta === 0) return origin >= min && origin <= max;
    const first = (min - origin) / delta;
    const second = (max - origin) / delta;
    const entry = Math.min(first, second);
    const exit = Math.max(first, second);
    near = Math.max(near, entry);
    far = Math.min(far, exit);
    return near <= far;
  };

  return clip(start.x, dx, rect.left, rect.right) && clip(start.y, dy, rect.top, rect.bottom);
};

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const speedBetween = (first: ArrivalIntentPoint, second: ArrivalIntentPoint): number => {
  const elapsed = second.time - first.time;
  return elapsed > 0 ? Math.hypot(second.x - first.x, second.y - first.y) / elapsed : 0;
};

const allChecksPass = (checks: ArrivalIntentChecks): boolean =>
  Object.values(checks).every(Boolean);

/**
 * Evaluate one approach without retaining state. Keeping this pure is what lets
 * the Storybook capture replay the same samples against new thresholds later.
 */
export function evaluateArrivalIntent(
  samples: readonly ArrivalIntentPoint[],
  rect: ArrivalIntentRect,
  config: Readonly<ArrivalIntentConfig> = DEFAULT_ARRIVAL_INTENT_CONFIG
): ArrivalIntentEvaluation {
  const current = samples.at(-1);
  const outsideTarget = current !== undefined && !pointInsideRect(current, rect);
  const enoughSamples = samples.length >= config.minSamples;

  if (!current || !isValidRect(rect) || !outsideTarget || !enoughSamples) {
    return {
      qualifies: false,
      checks: { ...EMPTY_CHECKS, outsideTarget, enoughSamples },
      metrics: emptyMetrics(samples.length),
    };
  }

  const distances = samples.map((sample) => distanceToRect(sample, rect));
  const distancePx = distances.at(-1) ?? Number.POSITIVE_INFINITY;
  const approachDistancePx = (distances[0] ?? distancePx) - distancePx;
  let shrinkingSegments = 0;
  for (let index = 1; index < distances.length; index += 1) {
    if ((distances[index] ?? Infinity) < (distances[index - 1] ?? -Infinity)) {
      shrinkingSegments += 1;
    }
  }
  const shrinkingSegmentRatio = shrinkingSegments / Math.max(distances.length - 1, 1);
  const recentDistances = distances.slice(-(config.recentShrinkingSegmentCount + 1));
  const distanceRecentlyShrinking =
    recentDistances.length > config.recentShrinkingSegmentCount &&
    recentDistances.slice(1).every((distance, index) => distance < (recentDistances[index] ?? 0));

  const segmentSpeeds: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const first = samples[index - 1];
    const second = samples[index];
    if (first && second) segmentSpeeds.push(speedBetween(first, second));
  }
  const split = Math.max(1, Math.floor(segmentSpeeds.length / 2));
  const earlySpeeds = segmentSpeeds.slice(0, split);
  const recentSpeeds = segmentSpeeds.slice(split);
  const earlySpeedPxPerMs = average(earlySpeeds);
  const recentSpeedPxPerMs = average(recentSpeeds.length > 0 ? recentSpeeds : earlySpeeds);
  const brakingRatio = earlySpeedPxPerMs > 0 ? recentSpeedPxPerMs / earlySpeedPxPerMs : null;

  const recentStart = samples[Math.max(0, samples.length - Math.max(3, recentSpeeds.length + 1))];
  const elapsed = recentStart ? current.time - recentStart.time : 0;
  const velocityX = recentStart && elapsed > 0 ? (current.x - recentStart.x) / elapsed : 0;
  const velocityY = recentStart && elapsed > 0 ? (current.y - recentStart.y) / elapsed : 0;
  const velocityMagnitude = Math.hypot(velocityX, velocityY);
  const nearest = nearestPointInRect(current, rect);
  const targetX = nearest.x - current.x;
  const targetY = nearest.y - current.y;
  const headingCosine =
    velocityMagnitude > 0 && distancePx > 0
      ? (velocityX * targetX + velocityY * targetY) / (velocityMagnitude * distancePx)
      : -1;
  const approachSpeedPxPerMs = Math.max(0, velocityMagnitude * headingCosine);
  const timeToContactMs =
    approachSpeedPxPerMs > 0 ? distancePx / approachSpeedPxPerMs : Number.POSITIVE_INFINITY;
  const projectedX = current.x + velocityX * config.trajectoryHorizonMs;
  const projectedY = current.y + velocityY * config.trajectoryHorizonMs;

  const checks: ArrivalIntentChecks = {
    outsideTarget,
    enoughSamples,
    withinDistance: distancePx <= config.maxDistancePx,
    madeApproachProgress: approachDistancePx >= config.minApproachDistancePx,
    distanceMostlyShrinking: shrinkingSegmentRatio >= config.minShrinkingSegmentRatio,
    distanceRecentlyShrinking,
    headingTowardTarget: headingCosine >= config.minHeadingCosine,
    earlySpeedHighEnough: earlySpeedPxPerMs >= config.minEarlySpeedPxPerMs,
    recentSpeedInRange:
      recentSpeedPxPerMs >= config.minRecentSpeedPxPerMs &&
      recentSpeedPxPerMs <= config.maxRecentSpeedPxPerMs,
    braking: brakingRatio !== null && brakingRatio <= config.maxBrakingRatio,
    projectsToTarget: segmentIntersectsRect(current, { x: projectedX, y: projectedY }, rect),
    contactSoon: timeToContactMs <= config.maxTimeToContactMs,
  };

  return {
    qualifies: allChecksPass(checks),
    checks,
    metrics: {
      sampleCount: samples.length,
      distancePx,
      approachDistancePx,
      shrinkingSegmentRatio,
      headingCosine,
      earlySpeedPxPerMs,
      recentSpeedPxPerMs,
      brakingRatio,
      approachSpeedPxPerMs,
      timeToContactMs: Number.isFinite(timeToContactMs) ? timeToContactMs : null,
      projectedX,
      projectedY,
    },
  };
}

export class ArrivalIntentDetector {
  private readonly samples: ArrivalIntentPoint[] = [];
  private predictedUntil = Number.NEGATIVE_INFINITY;
  private evaluation: ArrivalIntentEvaluation = EMPTY_ARRIVAL_INTENT_EVALUATION;

  constructor(
    private readonly config: Readonly<ArrivalIntentConfig> = DEFAULT_ARRIVAL_INTENT_CONFIG
  ) {}

  push(sample: ArrivalIntentPoint, rect: ArrivalIntentRect): ArrivalIntentUpdate {
    if (!isFinitePoint(sample) || !isValidRect(rect)) {
      this.reset();
      return this.updateAt(sample.time);
    }

    const previous = this.samples.at(-1);
    if (
      previous &&
      (sample.time <= previous.time || sample.time - previous.time > this.config.resetAfterMs)
    ) {
      this.samples.length = 0;
    }

    this.samples.push(sample);
    const cutoff = sample.time - this.config.sampleWindowMs;
    while ((this.samples[0]?.time ?? cutoff) < cutoff) this.samples.shift();

    const wasActive = this.hasPrediction(sample.time);
    this.evaluation = evaluateArrivalIntent(this.samples, rect, this.config);
    if (this.evaluation.qualifies) {
      this.predictedUntil = sample.time + this.config.predictionTtlMs;
    }

    return {
      evaluation: this.evaluation,
      predictionActive: this.hasPrediction(sample.time),
      predictionActivated: this.evaluation.qualifies && !wasActive,
      predictedUntil: this.hasPrediction(sample.time) ? this.predictedUntil : null,
    };
  }

  hasPrediction(time: number): boolean {
    return Number.isFinite(time) && time <= this.predictedUntil;
  }

  consumePrediction(time: number): boolean {
    if (!this.hasPrediction(time)) return false;
    this.predictedUntil = Number.NEGATIVE_INFINITY;
    return true;
  }

  getEvaluation(): ArrivalIntentEvaluation {
    return this.evaluation;
  }

  reset(): void {
    this.samples.length = 0;
    this.predictedUntil = Number.NEGATIVE_INFINITY;
    this.evaluation = EMPTY_ARRIVAL_INTENT_EVALUATION;
  }

  private updateAt(time: number): ArrivalIntentUpdate {
    return {
      evaluation: this.evaluation,
      predictionActive: this.hasPrediction(time),
      predictionActivated: false,
      predictedUntil: this.hasPrediction(time) ? this.predictedUntil : null,
    };
  }
}
