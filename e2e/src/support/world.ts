import { World, setWorldConstructor } from '@cucumber/cucumber';
import { ElectronHarness } from './electron-harness.js';
import { OnboardingPage } from './pages/onboarding-page.js';
import { ReviewPage } from './pages/review-page.js';
import { SessionPage } from './pages/session-page.js';
import { WorkSessionPage, type WorkSessionResources } from './pages/work-session-page.js';
import { WorkSessionFixture, type ScriptedAcpEvent } from './fixtures/work-session-fixture.js';
import { McpCatalogFixture, type McpCatalogAcpEvent } from './fixtures/mcp-catalog-fixture.js';
import { McpCatalogEditingFixture } from './fixtures/mcp-catalog-editing-fixture.js';
import type { SyntheticReviewRepository } from './fixtures/synthetic-review-repository.js';
import { McpCatalogPage } from './pages/mcp-catalog-page.js';
import { McpCatalogEditingPage } from './pages/mcp-catalog-editing-page.js';
import { SessionManagementFixture } from './fixtures/session-management-fixture.js';
import { SessionManagementPage } from './pages/session-management-page.js';
import { SessionReadStateFixture } from './fixtures/session-read-state-fixture.js';
import { SessionReadStatePage } from './pages/session-read-state-page.js';
import { SessionForkFixture } from './fixtures/session-fork-fixture.js';
import { SessionForkPage, type SessionForkResources } from './pages/session-fork-page.js';
import {
  SessionRelationLifecyclePage,
  type SessionRelationLifecycleResources,
} from './pages/session-relation-lifecycle-page.js';
import { ProjectLifecyclePage } from './pages/project-lifecycle-page.js';
import { ProjectReopenFixture } from './fixtures/project-reopen-fixture.js';
import { ProjectReopenPage } from './pages/project-reopen-page.js';
import { AgentRoleFixture } from './fixtures/agent-role-fixture.js';
import { AgentRolePage, type AgentRoleResources } from './pages/agent-role-page.js';
import { ShortcutPage } from './pages/shortcut-page.js';
import { SettingsAppearancePage } from './pages/settings-appearance-page.js';
import { createScenarioArtifacts, type ScenarioArtifacts } from './world-utils.js';

export class LodyWorld extends World {
  artifacts: ScenarioArtifacts | null = null;
  harness: ElectronHarness | null = null;
  onboarding: OnboardingPage | null = null;
  reviewPage: ReviewPage | null = null;
  sessionPage: SessionPage | null = null;
  workPage: WorkSessionPage | null = null;
  mcpPage: McpCatalogPage | null = null;
  mcpCatalogEditingPage: McpCatalogEditingPage | null = null;
  sessionManagementPage: SessionManagementPage | null = null;
  sessionReadStatePage: SessionReadStatePage | null = null;
  sessionForkPage: SessionForkPage | null = null;
  sessionRelationLifecyclePage: SessionRelationLifecyclePage | null = null;
  projectLifecyclePage: ProjectLifecyclePage | null = null;
  projectReopenPage: ProjectReopenPage | null = null;
  agentRolePage: AgentRolePage | null = null;
  shortcutPage: ShortcutPage | null = null;
  appearancePage: SettingsAppearancePage | null = null;
  workFixture: WorkSessionFixture | null = null;
  projectReopenFixture: ProjectReopenFixture | null = null;
  mcpFixture: McpCatalogFixture | null = null;
  mcpCatalogEditingFixture: McpCatalogEditingFixture | null = null;
  sessionManagementFixture: SessionManagementFixture | null = null;
  sessionReadStateFixture: SessionReadStateFixture | null = null;
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
    this.shortcutPage = new ShortcutPage(this.harness.page);
  }

  async configureSessionManagementJourney(): Promise<void> {
    if (!this.artifacts || !this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Session management setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.sessionManagementFixture = new SessionManagementFixture(
      `${this.artifacts.scenarioDir}/session-management-scripted-acp.ndjson`
    );
    this.sessionManagementPage = new SessionManagementPage(
      this.harness.page,
      this.sessionManagementFixture
    );
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.sessionManagementPage.configureAgentFromSettings();
  }

  async configureSessionReadStateJourney(): Promise<void> {
    if (!this.artifacts || !this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Session read-state setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.sessionReadStateFixture = new SessionReadStateFixture(
      `${this.artifacts.scenarioDir}/session-read-state-scripted-acp.ndjson`
    );
    this.sessionReadStatePage = new SessionReadStatePage(
      this.harness.page,
      this.sessionReadStateFixture
    );
    await this.onboarding.skipConfigurationAndEnterProduct();
    await this.sessionReadStatePage.configureAgentFromSettings();
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

  async configureMcpCatalogEditingJourney(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for MCP catalog editing setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.mcpCatalogEditingFixture = new McpCatalogEditingFixture();
    this.mcpCatalogEditingPage = new McpCatalogEditingPage(
      this.harness.page,
      this.mcpCatalogEditingFixture
    );
    await this.onboarding.skipConfigurationAndEnterProduct();
  }

  async configureSessionForkAgent(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Session fork setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.sessionForkFixture = await SessionForkFixture.create();
    this.sessionForkPage = new SessionForkPage(this.harness.page, this.sessionForkFixture);
    this.sessionRelationLifecyclePage = new SessionRelationLifecyclePage(this.harness.page);
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

  async configureProjectReopenJourney(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for project reopen setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.projectReopenFixture = await ProjectReopenFixture.create();
    this.projectReopenPage = new ProjectReopenPage(this.harness.page, this.projectReopenFixture);
    await this.onboarding.skipConfigurationAndEnterProduct();
  }

  async configureAppearanceJourney(): Promise<void> {
    if (!this.onboarding || !this.harness?.page) {
      throw new Error('Scenario is not ready for Appearance settings setup');
    }
    await this.onboarding.waitForLocalBootstrap();
    this.appearancePage = new SettingsAppearancePage(this.harness.page);
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
    this.projectReopenFixture?.dispose();
    this.sessionForkFixture?.dispose();
    this.reviewFixture = null;
    this.workFixture = null;
    this.projectReopenFixture = null;
    this.sessionForkFixture = null;
    this.agentRoleFixture = null;
    this.mcpFixture = null;
    this.mcpCatalogEditingFixture = null;
    this.sessionManagementFixture = null;
    this.sessionReadStateFixture = null;
  }
}

setWorldConstructor(LodyWorld);
