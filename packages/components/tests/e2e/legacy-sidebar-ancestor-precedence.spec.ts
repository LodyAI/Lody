import { expect, test, type Page, type TestInfo } from '@playwright/test';

const prefix = 'migration-ownedlegacysidebarparts--';
const cases = [
  {
    story: 'zero-specificity-header-gap',
    candidate: '[:where(&)_:where([data-sidebar=header])]:gap-12',
    target: '[data-sidebar=header]',
    property: 'gap',
  },
  {
    story: 'zero-specificity-menu-width',
    candidate: '[:where(&)_:where([data-sidebar=menu-button])]:w-7',
    target: '[data-sidebar=menu-button]:not(a)',
    property: 'width',
  },
  {
    story: 'zero-specificity-label-height',
    candidate: '[:where(&)_:where([data-sidebar=group-label])]:h-12',
    target: '[data-sidebar=group-label]',
    property: 'height',
  },
] as const;

test.use({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });

async function openParts(page: Page, story: string, theme: string) {
  await page.goto(
    `/iframe.html?id=${prefix}${story}&viewMode=story&globals=theme:${theme};locale:en`
  );
  await expect(page.locator('[data-sidebar-parts-fixture]')).toBeVisible();
  await expect(page.locator('[data-sidebar-parts-event]')).toHaveText('Ready');
  await expect(page.locator('[data-sidebar-parts-state]')).toHaveAttribute(
    'data-sidebar-parts-state',
    'expanded'
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
  await page.mouse.move(1200, 900);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity &&
                (animation.pending || animation.playState === 'running')
            ).length
      )
    )
    .toBe(0);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-sidebar=header]');
    const menu = document.querySelector('[data-sidebar=menu-button]:not(a)');
    const label = document.querySelector('[data-sidebar=group-label]');
    if (!header || !menu || !label) throw new Error('Missing actual Sidebar parts');
    return {
      headerGap: getComputedStyle(header).gap,
      header: header.getBoundingClientRect().toJSON(),
      menu: menu.getBoundingClientRect().toJSON(),
      label: label.getBoundingClientRect().toJSON(),
    };
  });
}

async function capture(page: Page, target: string, name: string, info: TestInfo) {
  const wholePath = info.outputPath(`${name}-sidebar.png`);
  const targetPath = info.outputPath(`${name}-target.png`);
  // Keep caret:initial: hiding an unfocused input's caret mutates its raw style attribute.
  const whole = await page.screenshot({ path: wholePath, caret: 'initial', animations: 'allow' });
  const part = await page
    .locator(target)
    .first()
    .screenshot({ path: targetPath, caret: 'initial', animations: 'allow' });
  await info.attach(`${name} actual Sidebar`, { path: wholePath, contentType: 'image/png' });
  await info.attach(`${name} actual target`, { path: targetPath, contentType: 'image/png' });
  return { whole, part };
}

async function verifyClick(page: Page) {
  await page.locator('[data-sidebar=menu-button]:not(a)').first().click();
  await expect(page.locator('[data-sidebar-parts-event]')).toHaveText('default');
  await expect(page.locator('[data-sidebar-parts-state]')).toHaveAttribute(
    'data-sidebar-parts-state',
    'expanded'
  );
}

for (const theme of ['light', 'dark']) {
  for (const scenario of cases) {
    test(`${theme}: ${scenario.story} preserves the default Sidebar cascade and rendering`, async ({
      page,
    }, info) => {
      await openParts(page, 'default', theme);
      const reference = await geometry(page);
      const referenceImages = await capture(page, scenario.target, 'reference', info);
      await verifyClick(page);

      await openParts(page, scenario.story, theme);
      await expect(page.locator('[data-external-sidebar-group]')).toHaveClass(
        new RegExp(scenario.candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      );
      const compiled = await page.evaluate(({ candidate, property }) => {
        const escaped = `.${CSS.escape(candidate)}`;
        const found: string[] = [];
        const walk = (rules: CSSRuleList, caller = false, utilities = false) => {
          for (const rule of Array.from(rules)) {
            const inUtilities = utilities || rule.cssText.startsWith('@layer utilities ');
            if (rule instanceof CSSStyleRule) {
              const inCaller = caller || rule.selectorText.includes(escaped);
              if (inUtilities && inCaller && rule.style.getPropertyValue(property)) {
                found.push(rule.cssText);
              }
              walk(rule.cssRules, inCaller, inUtilities);
            } else if (rule instanceof CSSGroupingRule) {
              walk(rule.cssRules, caller, inUtilities);
            }
          }
        };
        for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
        return found;
      }, scenario);
      expect(
        compiled,
        'The actual Tailwind utilities layer must contain this caller declaration'
      ).not.toHaveLength(0);
      const actual = await geometry(page);
      const callerImages = await capture(page, scenario.target, 'caller', info);
      await info.attach('actual caller CSS and measured geometry', {
        body: Buffer.from(
          JSON.stringify({ theme, scenario, compiled, reference, actual }, null, 2)
        ),
        contentType: 'application/json',
      });
      await verifyClick(page);

      expect(actual, 'A zero-specificity ancestor must retain the parts own layout').toEqual(
        reference
      );
      expect(
        callerImages.whole.equals(referenceImages.whole),
        'Actual full Sidebar PNGs differ'
      ).toBe(true);
      expect(callerImages.part.equals(referenceImages.part), 'Actual target PNGs differ').toBe(
        true
      );
    });
  }
}
