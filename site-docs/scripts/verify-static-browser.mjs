import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { collectSitePaths } from './site-paths.mjs';
import { createStaticHost } from './static-host.mjs';

// Run against the real production build, never a dev server or synthetic page.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(packageRoot, 'out/client');
const artifactDir = path.join(packageRoot, 'out/static-verification');
const phase = process.env.STATIC_TEST_PHASE ?? 'all';
assert.ok(['all', 'scan', 'faults', 'navigation', 'anchors'].includes(phase));
const host = createStaticHost({ root: output, port: 0 });
const server = await host.listen();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  headless: true,
});
const results = [];
const baselines = new Map();
const pagePaths = collectSitePaths(packageRoot).filter((p) => !['/404', '/zh/404'].includes(p));
const normalize = (p) => p.replace(/\/$/u, '') || '/';
const directoryPath = (p) => (p === '/' ? '/' : `${normalize(p)}/`);
const pagePathSet = new Set(pagePaths);
const failures = [];

async function run(name, action) {
  try {
    const detail = await action();
    results.push({ name, ok: true, ...detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function newContext({ js = true, mobile = false, block } = {}) {
  const context = await browser.newContext({
    javaScriptEnabled: js,
    viewport: mobile ? { width: 412, height: 915 } : { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  // Observe the end of preparation without modifying the production bundle.
  // This is only a synchronization signal; assertions inspect actual page state.
  await context.addInitScript(() => {
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (type, ...args) {
      const result = remove.call(this, type, ...args);
      if (this === window && type === 'vite:preloadError') window.__staticPreparationSettled = true;
      return result;
    };
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || (await block?.(url))) return route.abort('failed');
    return route.continue();
  });
  return context;
}

function snapshot(page) {
  return page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name=description]')?.content,
    canonical: document.querySelector('link[rel=canonical]')?.href,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content,
    alternates: [...document.querySelectorAll('link[hreflang]')].map((el) => el.href),
    lang: document.documentElement.lang,
    headings: [...document.querySelectorAll('h1')].map((el) => el.textContent.trim()),
    paragraphs: [...document.querySelectorAll('main p, #nd-page p')]
      .map((el) => el.textContent.trim())
      .filter(Boolean),
    articleText: document.querySelector('#nd-page .prose, .blog-prose')?.innerText,
    text: (document.querySelector('main, #nd-page') ?? document.body).innerText,
    links: [...document.querySelectorAll('a[href]')].map((el) => el.getAttribute('href')),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((el) =>
      JSON.parse(el.textContent)
    ),
  }));
}

function content(s) {
  return {
    title: s.title,
    description: s.description,
    canonical: s.canonical,
    headings: s.headings,
    paragraphs: s.paragraphs,
    articleText: s.articleText,
  };
}

async function baseline(urlPath) {
  if (baselines.has(urlPath)) return baselines.get(urlPath);
  const context = await newContext({ js: false });
  try {
    const page = await context.newPage();
    await page.goto(origin + urlPath);
    const data = await snapshot(page);
    baselines.set(urlPath, data);
    return data;
  } finally {
    await context.close();
  }
}

async function settled(page) {
  await page.waitForFunction(() => window.__staticPreparationSettled === true);
}

async function scan() {
  const context = await newContext({ js: false });
  const queue = [...pagePaths];
  const targets = new Set();
  try {
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        const page = await context.newPage();
        for (let urlPath; (urlPath = queue.shift()) !== undefined;) {
          await run(`no-js ${urlPath}`, async () => {
            const response = await page.goto(origin + directoryPath(urlPath));
            assert.equal(response.status(), 200);
            const data = await snapshot(page);
            assert.ok(data.title.trim().length > 0);
            assert.ok(data.description?.length > 5);
            const canonicalPath =
              urlPath === '/home' ? '/' : urlPath === '/zh/home' ? '/zh' : urlPath;
            assert.equal(data.canonical, `https://lody.ai${directoryPath(canonicalPath)}`);
            assert.equal(data.ogUrl, data.canonical);
            for (const alternate of data.alternates) {
              const url = new URL(alternate);
              assert.equal(
                url.pathname,
                directoryPath(url.pathname),
                `Redirecting alternate: ${alternate}`
              );
              assert.ok(
                pagePathSet.has(normalize(url.pathname)),
                `Unknown alternate: ${alternate}`
              );
            }
            assert.equal(data.lang, urlPath.startsWith('/zh') ? 'zh-CN' : 'en');
            assert.ok(data.headings.length > 0);
            assert.ok(await page.locator('h1').first().isVisible());
            assert.ok(data.text.length > 80);
            if (/^\/(zh\/)?docs(\/|$)/u.test(urlPath) || /^\/(zh\/)?blog\//u.test(urlPath)) {
              assert.ok(data.articleText?.length > 40, 'Prerendered article body must be present');
            }
            assert.ok(!data.text.includes('Something went wrong!'));
            assert.ok(data.links.length > 0);
            for (const href of data.links) {
              const url = new URL(href, page.url());
              // Hosted app/auth and third-party destinations are outside this static build.
              if (
                [origin, 'https://lody.ai'].includes(url.origin) &&
                !/^\/(app|login)(\/|$)/u.test(url.pathname)
              ) {
                if (pagePathSet.has(normalize(url.pathname))) {
                  assert.equal(
                    url.pathname,
                    directoryPath(url.pathname),
                    `Redirecting link: ${href}`
                  );
                }
                targets.add(url.pathname);
              }
            }
            baselines.set(urlPath, data);
            return { title: data.title, textLength: data.text.length };
          });
        }
        await page.close();
      })
    );
    await run('all internal static link targets', async () => {
      const broken = [];
      for (const target of targets) {
        const response = await fetch(origin + target, { redirect: 'manual' });
        if (response.status !== 200) broken.push({ target, status: response.status });
        await response.body?.cancel();
      }
      assert.deepEqual(broken, []);
      return { targets: targets.size };
    });
    await run('unknown URL is a static noindex 404', async () => {
      const page = await context.newPage();
      const response = await page.goto(origin + '/static-verification-missing-page');
      assert.equal(response.status(), 404);
      assert.match(await page.locator('meta[name=robots]').getAttribute('content'), /noindex/u);
      assert.equal(await page.locator('link[rel=canonical]').count(), 0);
      await page.close();
    });
  } finally {
    await context.close();
  }
}

async function faults() {
  for (const urlPath of [
    '/',
    '/zh',
    '/docs',
    '/zh/docs',
    '/docs/quickstart',
    '/zh/docs/quickstart',
    '/blog',
    '/zh/blog',
    '/blog/introducing-lody',
    '/zh/blog/introducing-lody',
  ]) {
    const before = await baseline(urlPath);
    const scripts = [];
    const pageErrors = [];
    const context = await newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (req) => {
      if (req.resourceType() === 'script' && req.url().startsWith(origin))
        scripts.push(new URL(req.url()).pathname);
    });
    try {
      await run(`healthy hydration ${urlPath}`, async () => {
        await page.goto(origin + urlPath);
        await settled(page);
        const theme = await page.locator('html').getAttribute('class');
        await page
          .getByRole('button', { name: /Toggle color theme|Switch to (light|dark) theme/u })
          .first()
          .click();
        await page.waitForFunction(
          (previous) => document.documentElement.className !== previous,
          theme
        );
        assert.ok(
          await page.evaluate(() =>
            Object.keys(document).some((key) => key.startsWith('__reactContainer$'))
          )
        );
        const after = await snapshot(page);
        assert.equal(after.title, before.title);
        assert.equal(after.canonical, before.canonical);
        assert.deepEqual(after.headings, before.headings);
        for (const paragraph of before.paragraphs) assert.ok(after.paragraphs.includes(paragraph));
        assert.deepEqual(
          pageErrors,
          [],
          'Healthy hydration must not replace mismatched server HTML'
        );
      });
      if (urlPath === '/' || urlPath === '/zh') {
        // The app preview renders real workspace components inside an
        // OptionalEnhancement boundary, so an app-only hook it newly reaches
        // blanks the stage without failing anything else on the page.
        await run(`landing app preview mounts ${urlPath}`, async () => {
          await page.locator('section.underwater-reveal').scrollIntoViewIfNeeded();
          await page
            .locator('.underwater-reveal__frame textarea')
            .first()
            .waitFor({ state: 'visible' });
        });
      }
    } finally {
      await context.close();
    }
    // Discover the actual hashed route entry from the build, rather than pinning a hash.
    let routeScript;
    for (const script of scripts) {
      const source = await readFile(path.join(output, script), 'utf8');
      if (source.length < 20000 && /as component\b/u.test(source)) {
        routeScript = script;
        break;
      }
    }
    assert.ok(routeScript, `No route chunk found for ${urlPath}`);
    const articleScript = scripts.find((s) => /\/(quickstart|introducing-lody)-/u.test(s));
    if (/quickstart|introducing-lody/u.test(urlPath)) assert.ok(articleScript);
    const cases = [['route', (url) => url.pathname === routeScript]];
    if (articleScript) cases.push(['article', (url) => url.pathname === articleScript]);
    if (urlPath.includes('/docs') || urlPath.includes('/blog/'))
      cases.push(['static data', (url) => url.pathname.startsWith('/__tsr/')]);
    for (const [kind, matches] of cases) {
      let blocked = false;
      const failedContext = await newContext({
        block: (url) => {
          if (matches(url)) {
            blocked = true;
            return true;
          }
          return false;
        },
      });
      try {
        await run(`failed ${kind} ${urlPath}`, async () => {
          const failedPage = await failedContext.newPage();
          await failedPage.goto(origin + urlPath);
          await settled(failedPage);
          assert.ok(blocked, 'The intended request must actually fail');
          // React 19 registers the document root synchronously, even when its
          // render is deferred. This rules out a future queued error render,
          // rather than racing a snapshot against the React scheduler.
          assert.equal(
            await failedPage.evaluate(() =>
              Object.keys(document).some((key) => key.startsWith('__reactContainer$'))
            ),
            false
          );

          assert.deepEqual(content(await snapshot(failedPage)), content(before));
          assert.ok(
            !(await failedPage.locator('body').innerText()).includes('Something went wrong!')
          );
        });
      } finally {
        await failedContext.close();
      }
    }
  }
}

async function clickTo(page, link, destination) {
  await link.click();
  await page.waitForURL((url) => normalize(url.pathname) === destination);
  const expectedCanonical = destination.replace(/\/home$/u, '') || '/';
  await page.waitForFunction((expected) => {
    const canonical = document.querySelector('link[rel=canonical]')?.href;
    return canonical && (new URL(canonical).pathname.replace(/\/$/u, '') || '/') === expected;
  }, expectedCanonical);
  assert.ok(await page.locator('h1').first().isVisible());
  assert.equal(new URL(page.url()).pathname, directoryPath(destination));
  assert.equal(
    new URL((await snapshot(page)).canonical).pathname.replace(/\/$/u, '') || '/',
    destination.replace(/\/home$/u, '') || '/'
  );
}

async function navigation() {
  for (const prefix of ['', '/zh']) {
    for (const mobile of [false, true]) {
      const context = await newContext({ js: false, mobile });
      try {
        await run(
          `no-js navigation ${prefix || '/'} ${mobile ? 'mobile' : 'desktop'}`,
          async () => {
            const page = await context.newPage();
            await page.goto(origin + (prefix || '/'));
            if (mobile) await page.locator('summary.site-nav__toggle').click();
            const nav = page.getByRole('navigation', {
              name: mobile ? 'Primary mobile' : 'Primary',
              exact: true,
            });
            await clickTo(page, nav.locator(`a[href="${prefix}/docs/"]`), `${prefix}/docs`);
            await clickTo(
              page,
              page.locator(`#nd-page a[href="${prefix}/docs/session-handoff/"]`).first(),
              `${prefix}/docs/session-handoff`
            );
            await page.goto(origin + prefix + '/blog');
            const article = page.locator(`main a[href^="${prefix}/blog/"]`).first();
            const target = normalize(new URL(await article.getAttribute('href'), origin).pathname);
            await clickTo(page, article, target);
            await page.screenshot({
              path: path.join(
                artifactDir,
                `${prefix ? 'zh' : 'en'}-${mobile ? 'mobile' : 'desktop'}-no-js.png`
              ),
            });
          }
        );
      } finally {
        await context.close();
      }
    }
  }
  for (const prefix of ['', '/zh']) {
    const context = await newContext({ mobile: true });
    try {
      await run(`native menu with JS ${prefix || '/'}`, async () => {
        const page = await context.newPage();
        await page.goto(origin + (prefix || '/'));
        await settled(page);
        await page.locator('summary.site-nav__toggle').click();
        await page.waitForFunction(
          () =>
            document.querySelector('details.site-nav__mobile')?.open &&
            document.body.style.overflow === 'hidden'
        );
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () =>
            !document.querySelector('details.site-nav__mobile')?.open &&
            document.body.style.overflow !== 'hidden'
        );
        await page.locator('summary.site-nav__toggle').click();
        await clickTo(
          page,
          page
            .getByRole('navigation', { name: 'Primary mobile' })
            .locator(`a[href="${prefix}/blog/"]`),
          `${prefix}/blog`
        );
      });
    } finally {
      await context.close();
    }
  }
  for (const prefix of ['', '/zh']) {
    let blocked = false;
    const failedContext = await newContext({
      mobile: true,
      block: (url) => {
        if (/^\/assets\/(routes|zh)-/u.test(url.pathname)) {
          blocked = true;
          return true;
        }
        return false;
      },
    });
    try {
      await run(`native navigation after route failure ${prefix || '/'}`, async () => {
        const page = await failedContext.newPage();
        await page.goto(origin + (prefix || '/'));
        await settled(page);
        assert.ok(blocked);
        await page.locator('summary.site-nav__toggle').click();
        await clickTo(
          page,
          page
            .getByRole('navigation', { name: 'Primary mobile' })
            .locator(`a[href="${prefix}/docs/"]`),
          `${prefix}/docs`
        );
      });
    } finally {
      await failedContext.close();
    }
  }
  const release = Promise.withResolvers();
  let intercepted = false;
  const delayedContext = await newContext({
    mobile: true,
    block: async (url) => {
      if (!intercepted && /^\/assets\/routes-/u.test(url.pathname)) {
        intercepted = true;
        await release.promise;
      }
      return false;
    },
  });
  try {
    await run('native menu opened before hydration survives startup', async () => {
      const page = await delayedContext.newPage();
      const request = page.waitForRequest(/\/assets\/routes-/u);
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      await request;
      await page.locator('summary.site-nav__toggle').click();
      assert.ok(await page.locator('details.site-nav__mobile').evaluate((el) => el.open));
      release.resolve();
      await settled(page);
      await page.waitForFunction(() => document.body.style.overflow === 'hidden');
      assert.ok(await page.locator('details.site-nav__mobile').evaluate((el) => el.open));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('details.site-nav__mobile')?.open);
    });
  } finally {
    release.resolve();
    await delayedContext.close();
  }
}

async function anchorPosition(page, id) {
  await page.waitForFunction((target) => {
    const rect = document.getElementById(target)?.getBoundingClientRect();
    return rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
  }, id);
  assert.equal(decodeURIComponent(new URL(page.url()).hash), `#${id}`);
}

async function anchors() {
  for (const mobile of [false, true]) {
    for (const js of [false, true]) {
      const context = await newContext({ mobile, js });
      try {
        for (const [source, label, destination, id] of [
          ['/docs/', 'Daemon Mode', '/docs/cli', 'daemon-mode'],
          ['/zh/docs/local-project/', 'CLI 命令', '/zh/docs/cli', 'project-命令'],
        ]) {
          await run(
            `docs anchor ${source} ${mobile ? 'mobile' : 'desktop'} ${js ? 'hydrated' : 'no-js'}`,
            async () => {
              const page = await context.newPage();
              const errors = [];
              page.on('pageerror', (error) => errors.push(error.message));
              await page.goto(origin + source);
              const link = page.locator('#nd-page').getByRole('link', { name: label, exact: true });
              const expectedHref = `${directoryPath(destination)}#${encodeURI(id)}`;
              assert.equal(await link.getAttribute('href'), expectedHref);
              if (js) {
                await settled(page);
                assert.equal(await link.getAttribute('href'), expectedHref);
                await page.evaluate(() => {
                  window.__anchorDocument = true;
                });
              }
              await clickTo(page, link, destination);
              await anchorPosition(page, id);
              if (js) assert.equal(await page.evaluate(() => window.__anchorDocument), true);
              await page.reload();
              if (js) await settled(page);
              await anchorPosition(page, id);
              // Exercise the existing fragment-only table link on the destination too.
              await page.evaluate(() => window.scrollTo(0, 0));
              await page
                .locator('#nd-page table')
                .getByRole('link', {
                  name: source === '/docs/' ? 'Daemon mode' : 'Project 命令',
                  exact: true,
                })
                .click();
              await anchorPosition(page, id);
              assert.deepEqual(errors, []);
              await page.close();
            }
          );
        }
      } finally {
        await context.close();
      }
    }
    for (const [prefix, id] of [
      ['', 'daemon-mode'],
      ['/zh', 'daemon-模式'],
    ]) {
      const context = await newContext({ mobile });
      const query = '?from=docs&next=a%2Fb&label=%E4%B8%AD%E6%96%87';
      const href = `${prefix}/docs/cli${query}#${id}`;
      const source = prefix ? '/zh/docs/local-project/' : '/docs/';
      const originalHref = prefix
        ? '/zh/docs/cli/#project-%E5%91%BD%E4%BB%A4'
        : '/docs/cli#daemon-mode';
      // Vary only the MDX link input; production MDX, adapter and router still render it.
      await context.route('**/assets/*.js', async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replaceAll(originalHref, href);
        await route.fulfill({ response, body });
      });
      try {
        await run(`query + anchor ${prefix || 'en'} ${mobile ? 'mobile' : 'desktop'}`, async () => {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${origin}${prefix}/docs/session/`);
          await settled(page);
          if (mobile) await page.getByRole('button', { name: 'Open Sidebar', exact: true }).click();
          await clickTo(page, page.locator(`a[href="${source}"]`).first(), normalize(source));
          const expectedHref = `${prefix}/docs/cli/${query}#${encodeURI(id)}`;
          const link = page.locator('#nd-page').getByRole('link', {
            name: prefix ? 'CLI 命令' : 'Daemon Mode',
            exact: true,
          });
          await link.waitFor();
          assert.equal(await link.getAttribute('href'), expectedHref);
          await page.evaluate(() => {
            window.__anchorDocument = true;
          });
          await clickTo(page, link, `${prefix}/docs/cli`);
          assert.equal(await page.evaluate(() => window.__anchorDocument), true);
          assert.equal(new URL(page.url()).search, query);
          await anchorPosition(page, id);
          await page.reload();
          await settled(page);
          assert.equal(new URL(page.url()).search, query);
          await anchorPosition(page, id);
          assert.deepEqual(errors, []);
        });
      } finally {
        await context.close();
      }
    }
  }
}

try {
  await mkdir(artifactDir, { recursive: true });
  if (phase === 'all' || phase === 'scan') await scan();
  if (phase === 'all' || phase === 'faults') await faults();
  if (phase === 'all' || phase === 'navigation') await navigation();
  if (phase === 'all' || phase === 'anchors') await anchors();
} finally {
  await writeFile(
    path.join(artifactDir, `${phase}.json`),
    JSON.stringify({ results, failures }, null, 2)
  );
  await browser.close();
  await host.close();
}
assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
console.log(`Verified ${results.length} cases against the production static build.`);
