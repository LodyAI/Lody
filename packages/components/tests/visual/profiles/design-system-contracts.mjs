async function ready(page) {
  await page.waitForFunction(
    () =>
      window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished' &&
      document.querySelector('[data-design-system-proof]')
  );
  await page.locator('#ds-composer').waitFor({ state: 'visible' });
}
async function check(page, focused) {
  const results = await page.evaluate((focus) => {
    const scope = document.querySelector('[data-design-system-proof]');
    const failures = [];
    const css = (node, property, pseudo) =>
      getComputedStyle(node, pseudo).getPropertyValue(property);
    const ref = (name) => scope.querySelector(`[data-ds-token="${name}"]`);
    const equal = (name, actual, expected) => {
      if (actual !== expected) failures.push(`${name}: ${actual} != ${expected}`);
    };
    const composer = scope.querySelector('[data-lody-composer-box]');
    const prompt = scope.querySelector('#ds-composer');
    const standalone = scope.querySelector('#ds-standalone-field');
    if (!composer || !prompt || !standalone) return ['Missing real product controls'];
    equal(
      'card background',
      css(composer, 'background-color'),
      css(ref('card'), 'background-color')
    );
    equal(
      'card shadow/focus',
      css(composer, 'box-shadow'),
      css(ref(focus ? 'focus' : 'card'), 'box-shadow')
    );
    equal('card radius', css(composer, 'border-radius'), css(ref('card'), 'border-radius'));
    equal('card border', css(composer, 'border-top-width'), '0px');
    equal(
      'page title size',
      css(scope.querySelector('h1'), 'font-size'),
      css(ref('title'), 'font-size')
    );
    equal(
      'page title leading',
      css(scope.querySelector('h1'), 'line-height'),
      css(ref('title'), 'line-height')
    );
    const caption = [...composer.querySelectorAll('div')].find(
      (node) => node.children.length === 0 && node.textContent === '45%'
    );
    if (!caption) failures.push('Missing real media progress caption');
    else {
      equal('media scrim', css(caption, 'background-color'), css(ref('media'), 'background-color'));
      equal('media label', css(caption, 'color'), css(ref('media'), 'color'));
    }

    equal(
      'prompt placeholder',
      css(prompt, 'color', '::placeholder'),
      css(ref('placeholder'), 'color')
    );
    equal('bare prompt shadow', css(prompt, 'box-shadow'), 'none');
    const fieldBox = standalone.matches('[data-slot="mention-input"]')
      ? standalone.parentElement
      : standalone;
    equal(
      'field background',
      css(fieldBox, 'background-color'),
      css(ref('field'), 'background-color')
    );
    equal('field well', css(fieldBox, 'box-shadow'), css(ref('field'), 'box-shadow'));
    equal('field radius', css(fieldBox, 'border-radius'), css(ref('field'), 'border-radius'));
    for (const property of ['font-size', 'line-height', 'font-weight', 'letter-spacing', 'color'])
      equal(`field ${property}`, css(standalone, property), css(ref('field'), property));
    equal(
      'field placeholder',
      css(standalone, 'color', '::placeholder'),
      css(ref('placeholder'), 'color')
    );
    if (scope.dataset.fallback !== 'true') {
      const chip = fieldBox.querySelector(
        '[data-mention-layer="chip"] [data-mention-kind="pasted_text"]'
      );
      if (!chip) failures.push('Missing real mention chip');
      else {
        equal(
          'chip opaque backdrop',
          css(chip, 'background-color'),
          css(scope, 'background-color')
        );
        const fill = css(fieldBox, 'background-color');
        equal(
          'chip well overlay',
          css(chip, 'background-image'),
          `linear-gradient(${fill}, ${fill})`
        );
      }
    }
    const status = scope.querySelector('[role="status"]');
    equal('status text', css(status, 'color'), css(ref('secondary'), 'color'));
    equal('warning mark', css(status.querySelector('svg'), 'color'), css(ref('warning'), 'color'));
    const effectiveOpacity = (node) => {
      let opacity = 1;
      for (let element = node; element && element !== scope; element = element.parentElement)
        opacity *= Number(css(element, 'opacity'));
      return opacity;
    };
    const disabled = scope.dataset.disabled === 'true';
    for (const node of [prompt, standalone, ...scope.querySelectorAll('button:disabled')]) {
      const expected = disabled ? 0.45 : 1;
      if (Math.abs(effectiveOpacity(node) - expected) > 1e-8)
        failures.push(`effective disabled opacity: ${effectiveOpacity(node)} != ${expected}`);
    }
    return failures;
  }, focused);
  if (results.length) throw Error(results.join('\n'));
}
const scenarios = [];
for (const theme of ['light', 'dark'])
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 1000 },
  ]) {
    for (const story of ['mention', 'disabled', 'plain-fallback']) {
      scenarios.push({
        id: `ds-${story}-${viewport.width}-${theme}`,
        path: `/iframe.html?id=design-system-product-convergence--${story}&viewMode=story&globals=theme:${theme};locale:en`,
        theme,
        viewport,
        root: 'body',
        ready,
        async act(page) {
          await page.locator('[data-ds-token="card"]').click();
          await check(page, false);
        },
      });
    }
    scenarios.push({
      id: `ds-focus-${viewport.width}-${theme}`,
      path: `/iframe.html?id=design-system-product-convergence--mention&viewMode=story&globals=theme:${theme};locale:en`,
      theme,
      viewport,
      root: 'body',
      ready,
      async act(page) {
        await page.locator('#ds-composer').focus();
        await page.waitForFunction(
          () =>
            document.activeElement?.id === 'ds-composer' &&
            document
              .getAnimations()
              .every(
                (a) =>
                  a.effect?.getTiming().iterations === Infinity ||
                  (!a.pending && a.playState !== 'running')
              )
        );
        await check(page, true);
      },
    });
  }
export default { name: 'design-system-after-contracts-not-old-equivalence', scenarios };
