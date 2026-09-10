import { World, setWorldConstructor } from '@cucumber/cucumber';
import { ElectronHarness } from './electron-harness.js';
import { OnboardingPage } from './pages/onboarding-page.js';
import { ReviewPage } from './pages/review-page.js';
import { SessionPage } from './pages/session-page.js';
import { WorkSessionPage, type WorkSessionResources } from './pages/work-session-page.js';
import { WorkSessionFixture, type ScriptedAcpEvent } from './fixtures/work-session-fixture.js';
import { McpCatalogFixture, type McpCatalogAcpEvent } from './fixtures/mcp-catalog-fixture.js';
import type { SyntheticReviewRepository } from './fixtures/synthetic-review-repository.js';
import { McpCatalogPage } from './pages/mcp-catalog-page.js';
import { SeededLocalSessionFixture } from './fixtures/seeded-local-session.js';
import {
  SessionManagementPage,
  type SessionRelationLifecycleResources,
} from './pages/session-management-page.js';
import { SessionForkFixture } from './fixtures/session-fork-fixture.js';
import { SessionForkPage, type SessionForkResources } from './pages/session-fork-page.js';
import { ProjectLifecyclePage } from './pages/project-lifecycle-page.js';
import { AgentRoleFixture } from './fixtures/agent-role-fixture.js';
import { AgentRolePage, type AgentRoleResources } from './pages/agent-role-page.js';
import { createScenarioArtifacts, type ScenarioArtifacts } from './world-utils.js';

export class LodyWorld extends World {
  artifacts: ScenarioArtifacts | null = null;
  harness: ElectronHarness | null = null;
  onboarding: OnboardingPage | null = null;
  reviewPage: ReviewPage | null = null;
  sessionPage: SessionPage | null = null;
  workPage: WorkSessionPage | null = null;
  mcpPage: McpCatalogPage | null = null;
  sessionManagementPage: SessionManagementPage | null = null;
  sessionForkPage: SessionForkPage | null = null;
  projectLifecyclePage: ProjectLifecyclePage | null = null;
  agentRolePage: AgentRolePage | null = null;
  workFixture: WorkSessionFixture | null = null;
  mcpFixture: McpCatalogFixture | null = null;
  seededSessionFixture: SeededLocalSessionFixture | null = null;
  sessionForkFixture: SessionForkFixture | null = null;
  agentRoleFixture: AgentRoleFixture | null = null;
  reviewFixture: SyntheticReviewRepository | null = null;
  activeAcpEvent: ScriptedAcpEvent | null = null;
  mcpSessionEvent: McpCatalogAcpEvent | null = null;
  workResources: WorkSessionResources | null = null;
  sessionForkResources: SessionForkResources | null = null;
  sessionRelationLifecycleResources: SessionRelationLifecycleResources | null = null;
  agentRoleResources: AgentRoleResources | null = null;

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
    this.seededSessionFixture = new SeededLocalSessionFixture();
    this.sessionManagementPage = new SessionManagementPage(
      this.harness.page,
      this.seededSessionFixture
    );
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

  async configureMcpCatalogJourney(): Promise<void> {
    if (!this.artifacts || !this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for MCP catalog setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.mcpFixture = new McpCatalogFixture(
      `${this.artifacts.scenarioDir}/mcp-scripted-acp.ndjson`,
      `${this.artifacts.scenarioDir}/synthetic-stdio-mcp.ndjson`
    );
    this.mcpPage = new McpCatalogPage(this.harness.page, this.mcpFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.mcpPage.configureCustomAgent();
  }

  async configureSessionForkAgent(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Session fork setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.sessionForkFixture = await SessionForkFixture.create();
    this.sessionForkPage = new SessionForkPage(this.harness.page, this.sessionForkFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.sessionForkPage.configureAgentFromSettings();
  }

  async configureProjectLifecycleJourney(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for project lifecycle setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.workFixture = await WorkSessionFixture.create();
    this.projectLifecyclePage = new ProjectLifecyclePage(this.harness.page, this.workFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
  }

  async configureAgentRoleJourney(): Promise<void> {
    if (!this.artifacts || !this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Agent Role setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.agentRoleFixture = new AgentRoleFixture(
      `${this.artifacts.scenarioDir}/agent-role-scripted-acp.ndjson`,
      `${this.artifacts.scenarioDir}/release-agent-role-prompt`
    );
    this.agentRolePage = new AgentRolePage(this.harness.page, this.agentRoleFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.agentRolePage.configureAgentFromSettings();
  }

  disposeFixtures(): void {
    this.reviewFixture?.cleanup();
    this.workFixture?.dispose();
    this.sessionForkFixture?.dispose();
    this.reviewFixture = null;
    this.workFixture = null;
    this.sessionForkFixture = null;
    this.agentRoleFixture = null;
    this.mcpFixture = null;
    this.seededSessionFixture = null;
  }
}

setWorldConstructor(LodyWorld);
