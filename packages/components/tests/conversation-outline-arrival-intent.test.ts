import { describe, expect, it } from 'vitest';
import {
  ArrivalIntentDetector,
  DEFAULT_ARRIVAL_INTENT_CONFIG,
  evaluateArrivalIntent,
  type ArrivalIntentPoint,
  type ArrivalIntentRect,
} from '../src/components/ai-gui/conversation-outline-arrival-intent';

const RAIL: ArrivalIntentRect = { left: 0, top: 100, right: 48, bottom: 300 };

const path = (xs: readonly number[], y = 180, intervalMs = 20): ArrivalIntentPoint[] =>
  xs.map((x, index) => ({ x, y, time: index * intervalMs }));

const deliberateApproach = () => path([220, 180, 148, 123, 104, 91, 82]);

describe('evaluateArrivalIntent', () => {
  it('qualifies a directed approach that brakes before reaching the rail', () => {
    const result = evaluateArrivalIntent(deliberateApproach(), RAIL);

    expect(result.qualifies).toBe(true);
    expect(result.checks).toEqual(
      expect.objectContaining({
        distanceMostlyShrinking: true,
        headingTowardTarget: true,
        braking: true,
        projectsToTarget: true,
      })
    );
    expect(result.metrics.brakingRatio).toBeLessThan(DEFAULT_ARRIVAL_INTENT_CONFIG.maxBrakingRatio);
  });

  it('rejects the fast constant-speed fly-by that trajectory-only predictors accept', () => {
    const result = evaluateArrivalIntent(path([220, 180, 140, 100, 60]), RAIL);

    expect(result.checks.projectsToTarget).toBe(true);
    expect(result.checks.braking).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('keeps a slow constant-speed approach on the ordinary hover delay', () => {
    const result = evaluateArrivalIntent(path([120, 114, 108, 102, 96, 90]), RAIL);

    expect(result.checks.distanceMostlyShrinking).toBe(true);
    expect(result.checks.earlySpeedHighEnough).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('rejects movement whose projection misses the rail vertically', () => {
    const result = evaluateArrivalIntent(
      deliberateApproach().map((sample) => ({ ...sample, y: 20 })),
      RAIL
    );

    expect(result.checks.projectsToTarget).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('rejects a reversal even when the cursor ends close to the rail', () => {
    const result = evaluateArrivalIntent(path([220, 170, 125, 96, 118, 88]), RAIL);

    expect(result.checks.distanceRecentlyShrinking).toBe(false);
    expect(result.qualifies).toBe(false);
  });

  it('does not qualify points already inside the rail', () => {
    const result = evaluateArrivalIntent(path([180, 130, 90, 60, 40]), RAIL);

    expect(result.checks.outsideTarget).toBe(false);
    expect(result.qualifies).toBe(false);
  });
});

describe('ArrivalIntentDetector', () => {
  it('arms one short-lived prediction that can be consumed exactly once', () => {
    const detector = new ArrivalIntentDetector();
    let update;
    let activated = false;
    for (const sample of deliberateApproach()) {
      update = detector.push(sample, RAIL);
      activated ||= update.predictionActivated;
    }

    expect(update?.predictionActive).toBe(true);
    expect(activated).toBe(true);
    expect(detector.consumePrediction(125)).toBe(true);
    expect(detector.consumePrediction(125)).toBe(false);
  });

  it('expires an unconsumed prediction', () => {
    const detector = new ArrivalIntentDetector();
    for (const sample of deliberateApproach()) detector.push(sample, RAIL);

    const finalTime = deliberateApproach().at(-1)?.time ?? 0;
    expect(detector.hasPrediction(finalTime + DEFAULT_ARRIVAL_INTENT_CONFIG.predictionTtlMs)).toBe(
      true
    );
    expect(
      detector.hasPrediction(finalTime + DEFAULT_ARRIVAL_INTENT_CONFIG.predictionTtlMs + 1)
    ).toBe(false);
  });

  it('starts a new gesture after a long sampling gap', () => {
    const detector = new ArrivalIntentDetector();
    for (const sample of deliberateApproach()) detector.push(sample, RAIL);

    const update = detector.push({ x: 75, y: 180, time: 500 }, RAIL);
    expect(update.evaluation.metrics.sampleCount).toBe(1);
    expect(update.evaluation.qualifies).toBe(false);
  });

  it('resets on invalid input rather than carrying a stale token', () => {
    const detector = new ArrivalIntentDetector();
    for (const sample of deliberateApproach()) detector.push(sample, RAIL);
    expect(detector.hasPrediction(125)).toBe(true);

    detector.push({ x: Number.NaN, y: 180, time: 130 }, RAIL);
    expect(detector.hasPrediction(130)).toBe(false);
    expect(detector.getEvaluation().metrics.sampleCount).toBe(0);
  });
});
