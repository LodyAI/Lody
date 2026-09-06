import { expect, type Page } from '@playwright/test';

type LocalBootstrapState = {
  cli: {
    phase?: string;
    startupStage?: string;
    runtimeOwnership?: string;
    runtime?: { pid?: number };
  } | null;
  snapshot: {
    userId?: string;
    workspace?: { workspaceId?: string; slug?: string | null };
  } | null;
};

export class OnboardingPage {
  constructor(private readonly page: Page) {}

  async waitForLocalBootstrap(): Promise<LocalBootstrapState> {
    await expect
      .poll(
        async () => {
          return await this.page.evaluate(async () => {
            if (window.__LODY_ELECTRON__ !== true || !window.ipc) return null;
            const [cli, snapshot] = await Promise.all([
              window.ipc.invoke('cli.getState'),
              window.ipc.invoke('localPlatform.getSnapshot'),
            ]);
            return { cli, snapshot };
          });
        },
        { timeout: 120_000, intervals: [100, 250, 500, 1000] }
      )
      .toMatchObject({
        cli: {
          phase: 'running',
          startupStage: 'ready',
          runtimeOwnership: 'owned',
        },
        snapshot: {
          userId: expect.stringMatching(/^local:/u),
          workspace: { workspaceId: expect.stringMatching(/^lw_/u), slug: 'local' },
        },
      });

    return (await this.page.evaluate(async () => {
      const [cli, snapshot] = await Promise.all([
        window.ipc!.invoke('cli.getState'),
        window.ipc!.invoke('localPlatform.getSnapshot'),
      ]);
      return { cli, snapshot };
    })) as LocalBootstrapState;
  }

  async skipConfigurationAndEnterProduct(): Promise<void> {
    await this.openAgentConfiguration();
    await this.page.getByRole('button', { name: /^(Skip for now|稍后再配置)$/u }).click();
    await expect(
      this.page.getByRole('heading', { name: /^(Explore Lody|探索 Lody)$/u })
    ).toBeVisible();
    await this.page.getByRole('button', { name: /^(Enter Lody|进入 Lody)$/u }).click();
    await expect(this.page.locator('#chat-prompt')).toBeVisible({ timeout: 60_000 });
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  async openAgentConfiguration(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Skip intro|跳过介绍)$/u }).click();
    await this.page.getByRole('button', { name: /^(Configure Lody|开始配置)$/u }).click();
    await expect(
      this.page.getByRole('heading', { name: /^(Connect a coding agent|连接一个编码 Agent)$/u })
    ).toBeVisible();
  }
}
