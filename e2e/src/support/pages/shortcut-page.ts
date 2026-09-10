import { expect, type Locator, type Page } from '@playwright/test';

const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const DEFAULT_SIDEBAR_BINDING = `${PRIMARY_MODIFIER}+b`;
const USER_SIDEBAR_BINDING = `${PRIMARY_MODIFIER}+Shift+9`;

export class ShortcutPage {
  private secondaryPage: Page | null = null;

  constructor(private readonly page: Page) {}

  async expectDefaultBindings(): Promise<void> {
    await this.expectDefaultBindingsOn(this.page);
  }

  async openSecondaryRenderer(): Promise<void> {
    const secondaryPagePromise = this.page.context().waitForEvent('page');
    await this.page.evaluate(async () => {
      if (!window.ipc) throw new Error('Electron IPC is unavailable');
      await window.ipc.invoke('app.openWindow', { workspace: 'local' });
    });
    this.secondaryPage = await secondaryPagePromise;
    await expect(this.secondaryPage.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async expectSecondaryDefaultBindings(): Promise<void> {
    await this.expectDefaultBindingsOn(this.requireSecondaryPage());
  }

  private async expectDefaultBindingsOn(page: Page): Promise<void> {
    await page.bringToFront();
    await this.expectSidebarVisible(page);

    await page.keyboard.press(`${PRIMARY_MODIFIER}+k`);
    const palette = page.getByPlaceholder(
      /^(Search commands and chats\.\.\.|搜索命令和对话\.\.\.)$/u
    );
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await page.keyboard.press(`${PRIMARY_MODIFIER}+,`);
    const settings = this.settingsDialog(page);
    await expect(settings).toBeVisible();
    await this.closeSettings(page, settings);
  }

  async rebindSidebarToggle(): Promise<void> {
    await this.page.bringToFront();
    await this.page.keyboard.press(`${PRIMARY_MODIFIER}+,`);
    const settings = this.settingsDialog(this.page);
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="keyboard-shortcuts"]').click();

    const label = settings.getByText(/^(Toggle Sidebar|切换侧边栏)$/u, { exact: true });
    const row = label.locator('..').locator('..');
    await row.getByTitle(/^(Click to record a new shortcut|点击录制新的快捷键)$/u).click();
    await this.page.keyboard.press(USER_SIDEBAR_BINDING);
    await expect(
      row.getByTitle(/^(Click to record a new shortcut|点击录制新的快捷键)$/u)
    ).toBeVisible();

    await this.closeSettings(this.page, settings);
    await this.waitForCommandDispatch(this.page);
  }

  async expectOnlyUserBindingTogglesSidebarInBothRenderers(): Promise<void> {
    await this.expectOnlyUserBindingTogglesSidebarOn(this.page);
    await this.expectOnlyUserBindingTogglesSidebarOn(this.requireSecondaryPage());
  }

  async expectOnlyUserBindingTogglesSidebarInSecondaryRenderer(): Promise<void> {
    await this.expectOnlyUserBindingTogglesSidebarOn(this.requireSecondaryPage());
  }

  private async expectOnlyUserBindingTogglesSidebarOn(page: Page): Promise<void> {
    await page.bringToFront();
    await this.expectSidebarVisible(page);

    await page.keyboard.press(DEFAULT_SIDEBAR_BINDING);
    await this.expectSidebarVisible(page);

    await page.keyboard.press(USER_SIDEBAR_BINDING);
    await this.expectSidebarHidden(page);

    await page.keyboard.press(USER_SIDEBAR_BINDING);
    await this.expectSidebarVisible(page);
  }

  async reloadSecondaryRenderer(): Promise<void> {
    const secondaryPage = this.requireSecondaryPage();
    await secondaryPage.reload();
    await expect(secondaryPage.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  private settingsDialog(page: Page): Locator {
    return page.getByRole('dialog').filter({
      has: page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
  }

  private async closeSettings(page: Page, settings: Locator): Promise<void> {
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
    await page.bringToFront();
  }

  private async waitForCommandDispatch(page: Page): Promise<void> {
    const palette = page.getByPlaceholder(
      /^(Search commands and chats\.\.\.|搜索命令和对话\.\.\.)$/u
    );
    await expect
      .poll(
        async () => {
          await page.keyboard.press(`${PRIMARY_MODIFIER}+k`);
          return await palette.isVisible();
        },
        { timeout: 5_000, intervals: [50, 100, 250] }
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }

  private sidebarSettingsButton(page: Page): Locator {
    return page.getByRole('button', { name: 'Settings', exact: true });
  }

  private async expectSidebarVisible(page: Page): Promise<void> {
    await expect(this.sidebarSettingsButton(page)).toBeVisible();
  }

  private async expectSidebarHidden(page: Page): Promise<void> {
    await expect(this.sidebarSettingsButton(page)).toBeHidden();
  }

  private requireSecondaryPage(): Page {
    if (!this.secondaryPage) throw new Error('The secondary Electron renderer is not open');
    return this.secondaryPage;
  }
}
