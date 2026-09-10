import { expect, type Locator, type Page } from '@playwright/test';

const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const DEFAULT_SIDEBAR_BINDING = `${PRIMARY_MODIFIER}+b`;
const USER_SIDEBAR_BINDING = `${PRIMARY_MODIFIER}+Shift+9`;

export class ShortcutPage {
  constructor(private readonly page: Page) {}

  async expectDefaultBindings(): Promise<void> {
    await this.expectSidebarVisible();

    await this.page.keyboard.press(`${PRIMARY_MODIFIER}+k`);
    const palette = this.page.getByPlaceholder(
      /^(Search commands and chats\.\.\.|搜索命令和对话\.\.\.)$/u
    );
    await expect(palette).toBeVisible();
    await this.page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await this.page.keyboard.press(`${PRIMARY_MODIFIER}+,`);
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
    await this.closeSettings(settings);
  }

  async rebindSidebarToggle(): Promise<void> {
    await this.page.keyboard.press(`${PRIMARY_MODIFIER}+,`);
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="keyboard-shortcuts"]').click();

    const label = settings.getByText(/^(Toggle Sidebar|切换侧边栏)$/u, { exact: true });
    const row = label.locator('..').locator('..');
    await row
      .getByTitle(/^(Click to record a new shortcut|点击录制新的快捷键)$/u)
      .click();
    await this.page.keyboard.press(USER_SIDEBAR_BINDING);
    await expect(
      row.getByTitle(/^(Click to record a new shortcut|点击录制新的快捷键)$/u)
    ).toBeVisible();

    await this.closeSettings(settings);
    await this.waitForCommandDispatch();
  }

  async expectOnlyUserBindingTogglesSidebar(): Promise<void> {
    await this.expectSidebarVisible();

    await this.page.keyboard.press(DEFAULT_SIDEBAR_BINDING);
    await this.expectSidebarVisible();

    await this.page.keyboard.press(USER_SIDEBAR_BINDING);
    await this.expectSidebarHidden();

    await this.page.keyboard.press(USER_SIDEBAR_BINDING);
    await this.expectSidebarVisible();
  }

  async reloadRenderer(): Promise<void> {
    await this.page.reload();
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  private settingsDialog(): Locator {
    return this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
  }

  private async closeSettings(settings: Locator): Promise<void> {
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
  }

  private async waitForCommandDispatch(): Promise<void> {
    const palette = this.page.getByPlaceholder(
      /^(Search commands and chats\.\.\.|搜索命令和对话\.\.\.)$/u
    );
    await expect
      .poll(
        async () => {
          await this.page.keyboard.press(`${PRIMARY_MODIFIER}+k`);
          return await palette.isVisible();
        },
        { timeout: 5_000, intervals: [50, 100, 250] }
      )
      .toBe(true);
    await this.page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }

  private sidebarSettingsButton(): Locator {
    return this.page.getByRole('button', { name: 'Settings', exact: true });
  }

  private async expectSidebarVisible(): Promise<void> {
    await expect(this.sidebarSettingsButton()).toBeVisible();
  }

  private async expectSidebarHidden(): Promise<void> {
    await expect(this.sidebarSettingsButton()).toBeHidden();
  }
}
