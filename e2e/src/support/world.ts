import { World, setWorldConstructor } from '@cucumber/cucumber';
import { ElectronHarness } from './electron-harness.js';
import { OnboardingPage } from './pages/onboarding-page.js';
import { ReviewPage } from './pages/review-page.js';
import { SessionPage } from './pages/session-page.js';
import { WorkSessionPage, type WorkSessionResources } from './pages/work-session-page.js';
import { WorkSessionFixture, type ScriptedAcpEvent } from './fixtures/work-session-fixture.js';
import type { SyntheticReviewRepository } from './fixtures/synthetic-review-repository.js';
import { createScenarioArtifacts, type ScenarioArtifacts } from './world-utils.js';

export class LodyWorld extends World {
  artifacts: ScenarioArtifacts | null = null;
  harness: ElectronHarness | null = null;
  onboarding: OnboardingPage | null = null;
  reviewPage: ReviewPage | null = null;
  sessionPage: SessionPage | null = null;
  workPage: WorkSessionPage | null = null;
  workFixture: WorkSessionFixture | null = null;
  reviewFixture: SyntheticReviewRepository | null = null;
  activeAcpEvent: ScriptedAcpEvent | null = null;
  workResources: WorkSessionResources | null = null;

  prepare(tags: readonly string[]): void {
    this.artifacts = createScenarioArtifacts(tags);
    this.harness = new ElectronHarness(this.artifacts);
  }

  async launch(): Promise<void> {
    if (!this.harness) throw new Error('Scenario was not prepared');
    await this.harness.launch();
    if (!this.harness.page) throw new Error('Electron did not open a main window');
    this.onboarding = new OnboardingPage(this.harness.page);
    this.reviewPage = new ReviewPage(this.harness.page);
    this.workPage = new WorkSessionPage(this.harness.page);
  }

  async configureScriptedAgent(): Promise<void> {
    if (!this.artifacts || !this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for scripted Agent setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.workFixture = await WorkSessionFixture.create(
      `${this.artifacts.scenarioDir}/scripted-acp.ndjson`
    );
    this.sessionPage = new SessionPage(this.harness.page, this.workFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.sessionPage.configureCustomAgentFromSettings();
  }

  disposeFixtures(): void {
    this.reviewFixture?.cleanup();
    this.workFixture?.dispose();
    this.reviewFixture = null;
    this.workFixture = null;
  }
}

setWorldConstructor(LodyWorld);
