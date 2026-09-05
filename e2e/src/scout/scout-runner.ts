import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { ReviewPage } from '../support/pages/review-page.js';
import { SCRIPTED_AGENT_NAME, SessionPage } from '../support/pages/session-page.js';
import { WorkSessionPage } from '../support/pages/work-session-page.js';
import {
  createSyntheticReviewRepository,
  PRIMARY_REVIEW_DIFF_PATH,
  SECONDARY_REVIEW_DIFF_PATH,
  type SyntheticReviewRepository,
} from '../support/fixtures/synthetic-review-repository.js';
import {
  WorkSessionFixture,
  type ScriptedAcpEvent,
} from '../support/fixtures/work-session-fixture.js';
import { ElectronHarness } from '../support/electron-harness.js';
import type { ScenarioArtifacts } from '../support/world-utils.js';
import {
  analyzeScoutCheckpoints,
  buildAblationReport,
  type ScoutCheckpoint,
  type ScoutJourney,
  type SuspectedTrend,
} from './scout-analysis.js';

type ScoutOptions = {
  journeys: ScoutJourney[];
  iterations: number;
  warmup: number;
  checkpointEvery: number;
  ablation: boolean;
};

type JourneyResult = {
  journey: ScoutJourney;
  status: 'passed' | 'failed';
  durationMs: number;
  checkpoints: ScoutCheckpoint[];
  metrics: ReturnType<typeof analyzeScoutCheckpoints>['metrics'];
  suspectedTrends: SuspectedTrend[];
  error?: string;
};

function readIntegerOption(name: string, fallback: number): number {
  const position = process.argv.indexOf(name);
  if (position === -1) return fallback;
  const value = Number(process.argv[position + 1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseOptions(): ScoutOptions {
  const ablation = process.argv.includes('--ablation');
  const journeyPosition = process.argv.indexOf('--journey');
  const requestedJourney = journeyPosition === -1 ? 'all' : process.argv[journeyPosition + 1];
  if (!['all', 'session', 'review', 'work'].includes(requestedJourney ?? '')) {
    throw new Error('--journey must be one of: all, session, review, work');
  }
  const journeys: ScoutJourney[] =
    requestedJourney === 'all' ? ['session', 'review', 'work'] : [requestedJourney as ScoutJourney];
  const iterations = readIntegerOption('--iterations', ablation ? 12 : 30);
  const warmup = readIntegerOption('--warmup', ablation ? 0 : 3);
  const checkpointEvery = readIntegerOption('--checkpoint-every', ablation ? 1 : 5);
  if (iterations < 1) throw new Error('--iterations must be at least 1');
  if (checkpointEvery < 1) throw new Error('--checkpoint-every must be at least 1');
  const checkpointCount = Math.ceil(iterations / checkpointEvery);
  if (checkpointCount < 4) {
    throw new Error(
      `Scout requires at least 4 measured checkpoints; received ${checkpointCount} from ${iterations} iterations sampled every ${checkpointEvery}`
    );
  }
  return { journeys, iterations, warmup, checkpointEvery, ablation };
}

function createRoundId(): string {
  return `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function setupJourney(
  journey: ScoutJourney,
  roundRoot: string
): Promise<{
  artifacts: ScenarioArtifacts;
  harness: ElectronHarness;
  fixture: WorkSessionFixture;
  session: SessionPage;
  review: ReviewPage;
  work: WorkSessionPage;
}> {
  const journeyDir = join(roundRoot, journey);
  mkdirSync(journeyDir, { recursive: true });
  const artifacts: ScenarioArtifacts = {
    rootDir: roundRoot,
    scenarioDir: journeyDir,
    stableId: `SCOUT-${journey.toUpperCase()}`,
  };
  const harness = new ElectronHarness(artifacts);
  let fixture: WorkSessionFixture | null = null;
  try {
    await harness.launch();
    if (!harness.page) throw new Error('Electron did not open a main window');
    const onboarding = new OnboardingPage(harness.page);
    await onboarding.waitForLocalBootstrap();
    fixture = await WorkSessionFixture.create(join(journeyDir, 'scripted-acp.ndjson'));
    const session = new SessionPage(harness.page, fixture);
    const review = new ReviewPage(harness.page);
    const work = new WorkSessionPage(harness.page);
    await onboarding.skipConfigurationAndEnterProduct();
    await session.configureCustomAgentFromSettings();
    return { artifacts, harness, fixture, session, review, work };
  } catch (error) {
    if (harness.page) {
      await harness.page
        .screenshot({ path: join(journeyDir, 'failure.png'), fullPage: true })
        .catch(() => undefined);
    }
    try {
      harness.writeDiagnostics();
    } catch {
      // Preserve the launch failure; diagnostics are best-effort evidence.
    }
    await harness.close().catch(() => undefined);
    fixture?.dispose();
    throw error;
  }
}

async function runSessionIteration(
  iteration: number,
  session: SessionPage,
  captureActive?: () => Promise<ScoutCheckpoint['active']>
): Promise<ScoutCheckpoint['active'] | null> {
  const prompt = await session.createHeldSession(
    `Scout Session lifecycle ${iteration} [SCOUT:HOLD]`
  );
  const active = captureActive ? await captureActive() : null;
  await session.stopHeldSession(prompt);
  await session.archiveAndDeleteSession(prompt);
  return active;
}

async function runReviewIteration(
  iteration: number,
  session: SessionPage,
  review: ReviewPage,
  repository: SyntheticReviewRepository,
  captureActive?: () => Promise<ScoutCheckpoint['active']>
): Promise<ScoutCheckpoint['active'] | null> {
  const prompt = await session.createCompletedSession(
    `Scout Review lifecycle ${iteration} [SCOUT:REPLY]`
  );
  await review.openChangesPanel(repository.changedPaths);
  await review.openChangedFile(PRIMARY_REVIEW_DIFF_PATH, repository.changedPaths);
  await review.hide();
  await review.show();
  await review.openChangedFile(SECONDARY_REVIEW_DIFF_PATH, repository.changedPaths);
  const active = captureActive ? await captureActive() : null;
  await review.closeDiffViewer();
  await review.closeChangesPanel();
  await session.archiveAndDeleteSession(prompt);
  return active;
}

async function runWorkIteration(
  iteration: number,
  fixture: WorkSessionFixture,
  work: WorkSessionPage,
  captureActive?: () => Promise<ScoutCheckpoint['active']>
): Promise<ScoutCheckpoint['active'] | null> {
  await work.enableWorktree();
  const priorPromptEnds = fixture
    .readAcpEvents()
    .filter((event) => event.event === 'prompt-end').length;
  await work.startSession(`Scout Work lifecycle ${iteration} [SCOUT:REPLY]`);
  const completed = await fixture.waitForAcpEvent('prompt-end', priorPromptEnds + 1);
  const prompt = completed.at(-1) as ScriptedAcpEvent;
  const marker = `lody-scout-terminal-${iteration}`;
  await work.openTerminalAndRun(`printf '${marker}\\n'`, marker);
  const resources = await work.captureResources();
  const active = captureActive ? await captureActive() : null;
  await work.archiveAndDeletePermanently(resources);
  await work.expectResourcesReleased(resources, [prompt.pid]);
  return active;
}

async function runJourney(
  journey: ScoutJourney,
  options: ScoutOptions,
  roundRoot: string
): Promise<JourneyResult> {
  const startedAt = Date.now();
  const checkpoints: ScoutCheckpoint[] = [];
  let harness: ElectronHarness | null = null;
  let fixture: WorkSessionFixture | null = null;
  let reviewRepository: SyntheticReviewRepository | null = null;
  let analysis: ReturnType<typeof analyzeScoutCheckpoints> = {
    metrics: [],
    suspectedTrends: [],
  };
  let failure: string | undefined;

  try {
    const context = await setupJourney(journey, roundRoot);
    harness = context.harness;
    fixture = context.fixture;

    if (journey === 'review') {
      reviewRepository = createSyntheticReviewRepository();
      const project = await context.review.registerLocalProject(reviewRepository.rootPath);
      await context.work.selectLocalProject(project.name);
    } else if (journey === 'work') {
      await context.work.addLocalProject(fixture.projectRoot, fixture.projectName);
      await context.work.selectAgent(SCRIPTED_AGENT_NAME);
    }

    const totalIterations = options.warmup + options.iterations;
    for (let run = 1; run <= totalIterations; run += 1) {
      const phase = run <= options.warmup ? 'warmup' : 'measure';
      const measuredIteration = run - options.warmup;
      const captureAblationWarmup = options.ablation && phase === 'warmup';
      const checkpointDue =
        phase === 'measure' &&
        (measuredIteration % options.checkpointEvery === 0 ||
          measuredIteration === options.iterations);
      const captureActive =
        captureAblationWarmup || checkpointDue ? () => harness!.captureSnapshot() : undefined;
      let active: ScoutCheckpoint['active'] | null;
      if (journey === 'session') {
        active = await runSessionIteration(run, context.session, captureActive);
      } else if (journey === 'review') {
        active = await runReviewIteration(
          run,
          context.session,
          context.review,
          reviewRepository!,
          captureActive
        );
      } else {
        active = await runWorkIteration(run, fixture, context.work, captureActive);
      }

      if (captureAblationWarmup || checkpointDue) {
        if (!active) throw new Error(`Scout ${journey} checkpoint did not capture active state`);
        const postGc = await harness.capturePostGcSnapshot();
        checkpoints.push({
          journey,
          iteration: phase === 'warmup' ? run : measuredIteration,
          phase,
          active,
          postGc,
        });
      }
      process.stdout.write(
        `[scout:${journey}] ${phase} ${phase === 'warmup' ? run : measuredIteration}/${
          phase === 'warmup' ? options.warmup : options.iterations
        }\n`
      );
    }

    analysis = analyzeScoutCheckpoints(checkpoints);
    const suspectedTrends = analysis.suspectedTrends.map((trend) => ({ journey, ...trend }));
    if (suspectedTrends.length > 0) {
      await harness.captureHeapSnapshots(join(harness.artifacts.scenarioDir, 'heap'));
      await harness.stopTrace(join(harness.artifacts.scenarioDir, 'trace.zip'));
    }
  } catch (error) {
    failure = errorText(error);
    if (harness?.page) {
      await harness.page
        .screenshot({ path: join(harness.artifacts.scenarioDir, 'failure.png'), fullPage: true })
        .catch(() => undefined);
      await harness
        .captureHeapSnapshots(join(harness.artifacts.scenarioDir, 'heap'))
        .catch(() => undefined);
      await harness
        .stopTrace(join(harness.artifacts.scenarioDir, 'trace.zip'))
        .catch(() => undefined);
    }
  } finally {
    if (harness) {
      try {
        harness.writeDiagnostics();
      } catch (error) {
        failure = `${failure ? `${failure}\n` : ''}diagnostics: ${errorText(error)}`;
      }
      await harness.close().catch((error) => {
        failure = `${failure ? `${failure}\n` : ''}teardown: ${errorText(error)}`;
      });
    }
    reviewRepository?.cleanup();
    fixture?.dispose();
  }

  const suspectedTrends = analysis.suspectedTrends.map((trend) => ({ journey, ...trend }));
  const result: JourneyResult = {
    journey,
    status: failure ? 'failed' : 'passed',
    durationMs: Date.now() - startedAt,
    checkpoints,
    metrics: analysis.metrics,
    suspectedTrends,
    ...(failure ? { error: failure } : {}),
  };
  const journeyDir = join(roundRoot, journey);
  mkdirSync(journeyDir, { recursive: true });
  writeFileSync(join(journeyDir, 'scout-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (options.ablation) {
    writeFileSync(
      join(journeyDir, 'ablation.json'),
      `${JSON.stringify(buildAblationReport(checkpoints), null, 2)}\n`
    );
  }
  return result;
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (options.ablation && options.journeys.length !== 1) {
    throw new Error('Ablation runs exactly one journey; pass --journey session, review, or work');
  }
  const roundId = createRoundId();
  const roundRoot = resolve(process.cwd(), 'artifacts', 'scout', roundId);
  mkdirSync(roundRoot, { recursive: true });
  const journeys: JourneyResult[] = [];
  for (const journey of options.journeys) {
    journeys.push(await runJourney(journey, options, roundRoot));
  }
  const suspectedTrends = journeys.flatMap((journey) => journey.suspectedTrends);
  const summary = {
    schemaVersion: 1,
    roundId,
    createdAt: new Date().toISOString(),
    options,
    journeys: journeys.map(({ checkpoints: _checkpoints, ...journey }) => journey),
    suspectedTrends,
  };
  writeFileSync(join(roundRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        roundRoot,
        journeys: journeys.map((journey) => ({
          journey: journey.journey,
          status: journey.status,
          durationMs: journey.durationMs,
          checkpoints: journey.checkpoints.length,
          suspectedTrends: journey.suspectedTrends.length,
          ...(journey.error ? { error: journey.error } : {}),
        })),
        suspectedTrends,
      },
      null,
      2
    )}\n`
  );
  if (journeys.some((journey) => journey.status === 'failed')) process.exitCode = 1;
}

await main();
