import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  After,
  Before,
  setDefaultTimeout,
  Status,
  type ITestCaseHookParameter,
} from '@cucumber/cucumber';
import { appendFailureIndex } from './world-utils.js';
import type { LodyWorld } from './world.js';

setDefaultTimeout(120_000);

Before(async function (this: LodyWorld, scenario: ITestCaseHookParameter) {
  const tags = scenario.pickle.tags.map((tag) => tag.name);
  this.prepare(tags);
  await this.launch();
});

After(async function (this: LodyWorld, scenario: ITestCaseHookParameter) {
  const failed = scenario.result?.status !== Status.PASSED;
  const harness = this.harness;
  const artifacts = this.artifacts;
  if (!harness || !artifacts) return;

  const evidenceErrors: string[] = [];
  let artifactDirectoryReady = false;
  try {
    mkdirSync(artifacts.scenarioDir, { recursive: true });
    artifactDirectoryReady = true;
  } catch (error) {
    evidenceErrors.push(`artifact directory: ${String(error)}`);
  }

  if (artifactDirectoryReady && harness.app && harness.page) {
    try {
      await harness.captureSnapshot();
      const cliBacklog = await harness.captureCliBacklog();
      writeFileSync(
        join(artifacts.scenarioDir, 'cli-backlog.json'),
        `${JSON.stringify(cliBacklog, null, 2)}\n`,
        'utf8'
      );
    } catch (error) {
      evidenceErrors.push(`runtime evidence: ${String(error)}`);
    }
  }
  if (artifactDirectoryReady && failed) {
    try {
      await harness.page?.screenshot({
        path: join(artifacts.scenarioDir, 'failure.png'),
        fullPage: true,
      });
      await harness.stopTrace(join(artifacts.scenarioDir, 'trace.zip'));
    } catch (error) {
      evidenceErrors.push(`failure evidence: ${String(error)}`);
    }
    try {
      appendFailureIndex(artifacts);
    } catch (error) {
      evidenceErrors.push(`failure index: ${String(error)}`);
    }
  } else if (artifactDirectoryReady && process.env.LODY_ACCEPTANCE_ROUND_ID) {
    try {
      await harness.capturePostGcSnapshot();
      await harness.page?.screenshot({
        path: join(artifacts.scenarioDir, 'checkpoint.png'),
        fullPage: true,
      });
      await harness.stopTrace(join(artifacts.scenarioDir, 'trace.zip'));
    } catch (error) {
      evidenceErrors.push(`acceptance evidence: ${String(error)}`);
    }
  }

  if (artifactDirectoryReady) {
    try {
      harness.writeDiagnostics();
    } catch (error) {
      evidenceErrors.push(`diagnostics: ${String(error)}`);
    }
  }
  try {
    await harness.close();
  } catch (error) {
    evidenceErrors.push(`teardown: ${String(error)}`);
  }
  try {
    this.disposeFixtures();
  } catch (error) {
    evidenceErrors.push(`fixture cleanup: ${String(error)}`);
  }

  if (evidenceErrors.length > 0) {
    if (artifactDirectoryReady) {
      try {
        writeFileSync(
          join(artifacts.scenarioDir, 'evidence-errors.log'),
          `${evidenceErrors.join('\n')}\n`,
          'utf8'
        );
      } catch (error) {
        evidenceErrors.push(`evidence error log: ${String(error)}`);
      }
    }
    if (!failed) throw new Error(evidenceErrors.join('\n'));
  }
});
