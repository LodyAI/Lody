import { expect, test, type Page } from '@playwright/test';

test.use({ reducedMotion: 'no-preference' });
const STORY = '/iframe.html?id=components-loginpage--default&viewMode=story&globals=locale:en';

async function ready(page: Page) {
  await page.goto(STORY);
  await expect(page.getByRole('heading', { name: 'Welcome to Lody AI' })).toBeVisible();
  await page.waitForFunction(() => {
    const body = document.querySelector('[data-login-stage]')!.parentElement!.parentElement!;
    const style = getComputedStyle(body);
    return (
      style.opacity === '1' &&
      (style.transform === 'none' || new DOMMatrix(style.transform).f === 0)
    );
  });
}

async function settled(page: Page) {
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>('[data-login-stage]')!;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-login-row]')];
    const panel = stage.querySelector(`[data-login-panel="${stage.dataset.loginActive}"]`)!;
    return (
      Math.abs(stage.getBoundingClientRect().height - panel.getBoundingClientRect().height) < 0.1 &&
      stage.dataset.loginPhase === 'visible' &&
      rows.every(
        (row) =>
          row.dataset.loginRow === 'visible' &&
          Math.abs(
            row.getBoundingClientRect().height -
              (row.inert ? 0 : row.firstElementChild!.getBoundingClientRect().height)
          ) < 0.1
      )
    );
  });
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('[data-login-stage]')!;
    const panel = stage.querySelector<HTMLElement>(
      `[data-login-panel="${stage.dataset.loginActive}"]`
    )!;
    const email = document.querySelector<HTMLInputElement>('#email-auth-email')!;
    const nameRow = document.querySelector('#email-auth-name')!.closest('[data-login-row]')!;
    const opacity = (element: Element) => {
      let value = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        value *= Number(getComputedStyle(node).opacity);
      }
      return value;
    };
    return {
      height: stage.getBoundingClientRect().height,
      naturalHeight: panel.getBoundingClientRect().height,
      emailTop: email.getBoundingClientRect().top,
      emailLeft: email.getBoundingClientRect().left,
      emailOpacity: opacity(email),
      titleOpacity: opacity(document.querySelector('#login-title')!),
      titleTop: document.querySelector('#login-title')!.getBoundingClientRect().top,
      emailWidth: email.getBoundingClientRect().width,
      nameHeight: nameRow.getBoundingClientRect().height,
      nameNaturalHeight: nameRow.firstElementChild!.getBoundingClientRect().height,
      scroll: stage.closest('main')!.scrollTop,
      transform: getComputedStyle(panel).transform,
    };
  });
}

for (const width of [1000, 850, 390]) {
  test(`continuous compact login transitions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await ready(page);
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
    await settled(page);
    await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
    await page.getByLabel('Email address', { exact: true }).fill('draft@example.com');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
    await page.evaluate(() => {
      (window as any).loginDraftNodes = [
        document.querySelector('#email-auth-email'),
        document.querySelector('#email-auth-password'),
      ];
    });
    const signIn = await geometry(page);
    await page.screenshot({ path: testInfo.outputPath('sign-in.png') });
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await settled(page);
    const signUp = await geometry(page);
    expect(signUp.height - signIn.height).toBeGreaterThan(20);
    expect(signUp.height - signIn.height).toBeLessThan(80);
    expect(signUp.height).toBeCloseTo(signUp.naturalHeight, 0);
    expect(signUp.scroll).toBe(0);
    await page.getByLabel('Name', { exact: true }).fill('Draft Person');
    await page.screenshot({ path: testInfo.outputPath('sign-up.png') });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await settled(page);
    await expect(
      page.getByRole('button', { name: 'Continue with email', exact: true })
    ).toBeVisible();
    // Offscreen panels must be excluded from keyboard navigation and accessibility.
    await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
    await settled(page);
    expect((await geometry(page)).height).toBeCloseTo(signUp.height, 0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Draft Person');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await settled(page);
    expect((await geometry(page)).height).toBeCloseTo(signIn.height, 0);
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(
      'draft@example.com'
    );
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('synthetic-password');
    expect(
      await page.evaluate(() => {
        const nodes = (window as any).loginDraftNodes;
        return (
          nodes[0] === document.querySelector('#email-auth-email') &&
          nodes[1] === document.querySelector('#email-auth-password')
        );
      })
    ).toBe(true);
  });
}

for (const width of [1000, 390]) {
  test(`intermediate frames keep fields visible and reverse from their current position at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.clock.install({ time: new Date('2026-10-18T00:00:00Z') });
    await page.setViewportSize({ width, height: 1000 });
    await ready(page);
    await page.clock.pauseAt(new Date('2026-10-18T01:00:00Z'));
    const press = async (name: string) =>
      page.getByRole('button', { name, exact: true }).evaluate((el: HTMLElement) => el.click());
    const oauth = await geometry(page);
    await press('Continue with email');
    await page.clock.runFor(128);
    const slideMiddle = await geometry(page);
    expect(slideMiddle.emailLeft).toBeLessThan(oauth.emailLeft - 1);
    expect(slideMiddle.emailOpacity).toBe(1);
    expect(slideMiddle.titleOpacity).toBe(1);
    await page.clock.runFor(500);
    await settled(page);
    const signIn = await geometry(page);
    expect(slideMiddle.emailLeft).toBeGreaterThan(signIn.emailLeft + 1);
    await press('Create account');
    await page.clock.runFor(128);
    const middle = await geometry(page);
    expect(middle.height).toBeGreaterThan(signIn.height + 1);
    expect(Math.abs(middle.emailTop - signIn.emailTop)).toBeGreaterThan(1);
    expect(middle.emailOpacity).toBe(1);
    expect(middle.titleOpacity).toBe(1);
    expect(middle.emailWidth).toBeCloseTo(signIn.emailWidth, 1);
    expect(middle.nameHeight).toBeGreaterThan(1);
    expect(middle.nameHeight).toBeLessThan(middle.nameNaturalHeight - 1);
    expect(middle.transform).toBe('none');
    await press('Sign in');
    const reversal = await geometry(page);
    expect(Math.abs(reversal.height - middle.height)).toBeLessThan(1);
    expect(Math.abs(reversal.emailTop - middle.emailTop)).toBeLessThan(1);
    expect(Math.abs(reversal.titleTop - middle.titleTop)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath('mid-expansion.png') });
    await page.clock.runFor(500);
    await settled(page);
    expect((await geometry(page)).height).toBeCloseTo(signIn.height, 0);
    await press('Back');
    await page.clock.runFor(128);
    const slideBack = await geometry(page);
    // The destination OAuth action can reverse the track before the slide finishes.
    await press('Continue with email');
    expect(Math.abs((await geometry(page)).emailLeft - slideBack.emailLeft)).toBeLessThan(1);
    await page.clock.runFor(500);
    await settled(page);
    expect((await geometry(page)).emailLeft).toBeCloseTo(signIn.emailLeft, 0);
    await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
    await page.clock.resume();
  });
}

test('reduced motion commits compact heights without running animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await settled(page);
  const signIn = await geometry(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await settled(page);
  expect((await geometry(page)).height).toBeGreaterThan(signIn.height);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await settled(page);
  expect((await geometry(page)).height).toBeCloseTo(signIn.height, 0);
  expect(
    await page
      .locator('[data-login-stage]')
      .evaluate(
        (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length
      )
  ).toBe(0);
});
