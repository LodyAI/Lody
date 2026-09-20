import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { ElectronHarness, type BootProfileSnapshot } from '../support/electron-harness.js';
import { OnboardingPage } from '../support/pages/onboarding-page.js';
import { LoadSessionPage } from '../support/pages/load-session-page.js';
import { LoadSessionFixture } from '../support/fixtures/load-session-fixture.js';
import type { ScenarioArtifacts } from '../support/world-utils.js';

type LoadOptions = {
  sessions: number;
  bodyBytes: number[];
  samples: number;
  cdpPort?: number;
};

function readInteger(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function readBodySizes(): number[] {
  const index = process.argv.indexOf('--body-bytes');
  if (index === -1) return [1024, 8192, 65536];
  const value = process.argv[index + 1];
  if (!value) throw new Error('--body-bytes requires comma-separated values');
  const sizes = value.split(',').map((entry) => Number(entry));
  if (
    sizes.length === 0 ||
    sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 256 * 1024)
  ) {
    throw new Error('--body-bytes values must be integers from 1 through 262144');
  }
  return sizes;
}

function parseOptions(): LoadOptions {
  const sessions = readInteger('--sessions', 24);
  const samples = readInteger('--samples', 4);
  const cdpPortIndex = process.argv.indexOf('--cdp-port');
  const cdpPort = cdpPortIndex === -1 ? undefined : Number(process.argv[cdpPortIndex + 1]);
  if (cdpPort !== undefined && (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535)) {
    throw new Error('--cdp-port must be a TCP port between 1024 and 65535');
  }
  return { sessions, bodyBytes: readBodySizes(), samples, cdpPort };
}

function roundId(): string {
  return `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function waitForComposer(page: NonNullable<ElectronHarness['page']>): Promise<void> {
  await expect(page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
}

function summarizeBlankSurface(boot: BootProfileSnapshot | null): {
  frameSampleCount: number;
  blankFrameCount: number;
  firstBlankAtMs: number | null;
  firstNonBlankAtMs: number | null;
  continuousBlankDurationMs: number | null;
} | null {
  if (!boot) return null;
  const firstBlank = boot.frames.find((frame) => frame.blank);
  const firstNonBlank = boot.frames.find((frame) => !frame.blank);
  return {
    frameSampleCount: boot.frames.length,
    blankFrameCount: boot.frames.filter((frame) => frame.blank).length,
    firstBlankAtMs: firstBlank?.atMs ?? null,
    firstNonBlankAtMs: firstNonBlank?.atMs ?? null,
    continuousBlankDurationMs:
      firstBlank && firstNonBlank ? Math.max(0, firstNonBlank.atMs - firstBlank.atMs) : null,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const rootDir = resolve(process.cwd(), 'artifacts', 'load', roundId());
  const seedDir = join(rootDir, 'seed');
  const reopenDir = join(rootDir, 'reopen');
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(reopenDir, { recursive: true });
  const seedArtifacts: ScenarioArtifacts = { rootDir, scenarioDir: seedDir, stableId: 'LOAD-SEED' };
  const reopenArtifacts: ScenarioArtifacts = {
    rootDir,
    scenarioDir: reopenDir,
    stableId: 'LOAD-REOPEN',
  };
  const fixture = new LoadSessionFixture(join(seedDir, 'load-agent.ndjson'));
  const seedHarness = new ElectronHarness(seedArtifacts);
  const warmHarness = new ElectronHarness(reopenArtifacts);
  let isolatedRoot: string | null = null;
  let failure: string | undefined;
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    options,
    status: 'running',
  };

  try {
    await seedHarness.launch({ forceOnboarding: true });
    if (!seedHarness.page) throw new Error('Seed Electron did not open a main window');
    const onboarding = new OnboardingPage(seedHarness.page);
    await onboarding.waitForLocalBootstrap();
    await onboarding.skipConfigurationAndEnterProduct();
    const seedPage = new LoadSessionPage(seedHarness.page, fixture);
    await seedPage.configureAgentFromSettings();

    const seededSizes: number[] = [];
    const seededSessionUrls: string[] = [];
    for (let index = 1; index <= options.sessions; index += 1) {
      const bodyBytes = options.bodyBytes[(index - 1) % options.bodyBytes.length]!;
      seededSessionUrls.push(await seedPage.createSession(index, bodyBytes));
      seededSizes.push(bodyBytes);
      await seedPage.returnHome();
      if (index % Math.max(1, Math.floor(options.sessions / 4)) === 0) {
        await seedHarness.captureSnapshot();
        process.stdout.write(`[load] seeded ${index}/${options.sessions}\n`);
      }
    }
    await seedHarness.markBootPoint('seed-complete');
    report.seedSnapshot = await seedHarness.captureSnapshot();
    report.seededSizes = seededSizes;
    isolatedRoot = seedHarness.getIsolatedRoot();
    seedHarness.writeDiagnostics();
    await seedHarness.close({ preserveRoot: true });

    await warmHarness.launch({
      reuseRoot: isolatedRoot,
      forceOnboarding: false,
      remoteDebuggingPort: options.cdpPort,
    });
    if (!warmHarness.page) throw new Error('Warm Electron did not open a main window');
    const warmPage = new LoadSessionPage(warmHarness.page, fixture);
    await waitForComposer(warmHarness.page);
    await warmHarness.markBootPoint('workspace-shell');
    await warmHarness.markBootPoint('composer-editable');
    await warmPage.openFirstSession();
    await warmHarness.markBootPoint('representative-message-visible');
    await warmHarness.page.mouse.wheel(0, 1200);
    await warmHarness.markBootPoint('scroll-exercised');
    for (let index = 0; index < seededSessionUrls.length; index += 1) {
      await warmPage.openSessionUrl(seededSessionUrls[index]!, seededSizes[index]!);
    }
    await warmHarness.captureSnapshot();
    for (let sample = 0; sample < options.samples; sample += 1) {
      await warmHarness.captureSnapshot();
    }
    await warmHarness.page.screenshot({
      path: join(reopenDir, 'heavy-session.png'),
      fullPage: true,
    });
    await warmHarness.stopTrace(join(reopenDir, 'trace.zip'));
    const boot = await warmHarness.captureBootProfile();
    report.reopen = {
      restoredSessionCount: seededSessionUrls.length,
      boot,
      blankSurface: summarizeBlankSurface(boot),
      snapshots: warmHarness.snapshots,
    };
    report.status = 'passed';
  } catch (error) {
    failure = errorText(error);
    report.status = 'failed';
    report.error = failure;
    if (warmHarness.page) {
      await warmHarness.page
        .screenshot({ path: join(reopenDir, 'failure.png'), fullPage: true })
        .catch(() => undefined);
      await warmHarness.stopTrace(join(reopenDir, 'trace.zip')).catch(() => undefined);
    } else if (seedHarness.page) {
      await seedHarness.page
        .screenshot({ path: join(seedDir, 'failure.png'), fullPage: true })
        .catch(() => undefined);
    }
  } finally {
    try {
      if (seedHarness.app) seedHarness.writeDiagnostics();
    } catch {
      // Preserve the primary load failure; diagnostics are best effort.
    }
    await seedHarness.close().catch(() => undefined);
    try {
      if (warmHarness.app) warmHarness.writeDiagnostics();
    } catch {
      // Preserve the primary load failure; diagnostics are best effort.
    }
    await warmHarness.close().catch((error) => {
      failure = `${failure ? `${failure}\n` : ''}teardown: ${errorText(error)}`;
      report.status = 'failed';
      report.error = failure;
    });
    writeFileSync(
      join(rootDir, 'load-result.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
  }

  process.stdout.write(`${JSON.stringify({ rootDir, ...report }, null, 2)}\n`);
  if (failure) process.exitCode = 1;
}

await main();
