import { expect, type Locator, type Page } from '@playwright/test';

type Theme = 'dark' | 'light' | 'system';

const themeLabels: Record<Theme, RegExp> = {
  dark: /^(Dark|深色)$/u,
  light: /^(Light|浅色)$/u,
  system: /^(System|系统)$/u,
};

export class SettingsAppearancePage {
  constructor(private readonly page: Page) {}

  async commitLightTheme(): Promise<void> {
    const settings = await this.openAppearanceSettings();
    await this.selectTheme(settings, 'light');
    await this.expectThemeState('light');
    await this.closeSettings(settings);
  }

  async expectCommittedLightThemeAfterSettingsReopen(): Promise<void> {
    const settings = await this.openAppearanceSettings();
    await expect(this.themeTrigger(settings)).toHaveAccessibleName(themeLabels.light);
    await this.expectThemeState('light');
    await this.closeSettings(settings);
  }

  async previewDarkThemeAndCancel(): Promise<void> {
    const settings = await this.openAppearanceSettings();
    await this.openThemeSelector(settings);
    const darkOption = this.themeOption('dark');
    await darkOption.hover();
    await this.expectThemeState('dark', 'light');

    await this.page.keyboard.press('Escape');
    await expect(darkOption).toBeHidden();
    await this.expectThemeState('light');
    await this.closeSettings(settings);
  }

  async expectCancelledPreviewKeepsCommittedLightTheme(): Promise<void> {
    const settings = await this.openAppearanceSettings();
    await expect(this.themeTrigger(settings)).toHaveAccessibleName(themeLabels.light);
    await this.expectThemeState('light');
    await this.closeSettings(settings);
  }

  private async openAppearanceSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="appearance"]').click();
    await expect(
      settings.getByRole('heading', { name: /^(Appearance|外观)$/u, exact: true })
    ).toBeVisible();
    return settings;
  }

  private async closeSettings(settings: Locator): Promise<void> {
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
  }

  private settingsDialog(): Locator {
    return this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
  }

  private themeTrigger(settings: Locator): Locator {
    return settings.getByRole('button', {
      name: /^(Dark|Light|System|深色|浅色|系统)$/u,
      exact: true,
    });
  }

  private themeOption(theme: Theme): Locator {
    return this.page.locator('[data-preview-item]').filter({ hasText: themeLabels[theme] });
  }

  private async openThemeSelector(settings: Locator): Promise<void> {
    await this.themeTrigger(settings).click();
    await expect(this.themeOption('dark')).toBeVisible();
  }

  private async selectTheme(settings: Locator, theme: Theme): Promise<void> {
    await this.openThemeSelector(settings);
    await this.themeOption(theme).click();
    await expect(this.themeOption(theme)).toBeHidden();
    await expect(this.themeTrigger(settings)).toHaveAccessibleName(themeLabels[theme]);
  }

  private async expectThemeState(resolvedTheme: 'dark' | 'light', storedTheme = resolvedTheme) {
    await expect
      .poll(() =>
        this.page.evaluate(() => ({
          classes: Array.from(document.documentElement.classList),
          storedTheme: window.localStorage.getItem('vite-ui-theme'),
        }))
      )
      .toEqual({ classes: expect.arrayContaining([resolvedTheme]), storedTheme });
  }
}
