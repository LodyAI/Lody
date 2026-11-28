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
const LOCALE_HTML_LANG = [
  ['/zh-hant', 'zh-Hant'],
  ['/zh', 'zh-CN'],
  ['/ja', 'ja'],
  ['/ko', 'ko'],
  ['/es', 'es'],
  ['/fr', 'fr'],
  ['/ru', 'ru'],
];
const expectedHtmlLang = (urlPath) => {
  for (const [prefix, lang] of LOCALE_HTML_LANG) {
    if (urlPath === prefix || urlPath.startsWith(`${prefix}/`)) return lang;
  }
  return 'en';
};
const pagePaths = collectSitePaths(packageRoot).filter(
  (p) => !/^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?404$/u.test(p)
);
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
    robots: document.querySelector('meta[name=robots]')?.content ?? null,
    canonical: document.querySelector('link[rel=canonical]')?.href,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content,
    alternates: [...document.querySelectorAll('link[hreflang]')].map((el) => el.href),
    lang: document.documentElement.lang,
    headings: [...document.querySelectorAll('h1')].map((el) => el.textContent.trim()),
    ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
    missingFragmentTargets: [...document.querySelectorAll('a[href^="#"]')]
      .map((el) => el.getAttribute('href'))
      .filter(
        (href) => href.length > 1 && !document.getElementById(decodeURIComponent(href.slice(1)))
      ),
    paragraphs: [...document.querySelectorAll('main p, #nd-page p')]
      .map((el) => el.textContent.trim())
      .filter(Boolean),
    articleText: document.querySelector('#nd-page .prose, .blog-prose')?.innerText,
    text: (document.querySelector('main, #nd-page') ?? document.body).innerText,
    links: [...document.querySelectorAll('a[href]')].map((el) => el.getAttribute('href')),
    linkDetails: [...document.querySelectorAll('a[href]')].map((el) => ({
      href: el.getAttribute('href'),
      rel: el.getAttribute('rel'),
    })),
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
  const idsByPath = new Map();
  const hashLinks = [];
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
            const isHomeCompat =
              urlPath === '/home' || /^\/(?:zh-hant|zh|ja|ko|es|fr|ru)\/home$/u.test(urlPath);
            if (isHomeCompat) {
              assert.match(
                data.robots ?? '',
                /noindex/u,
                'Compatibility /home route must be noindex'
              );
              assert.equal(
                data.canonical,
                undefined,
                'Compatibility /home route must omit canonical'
              );
              assert.equal(data.ogUrl, undefined, 'Compatibility /home route must omit og:url');
              assert.deepEqual(data.alternates, [], 'Compatibility /home route must omit hreflang');
              assert.deepEqual(data.jsonLd, [], 'Compatibility /home route must omit JSON-LD');
            } else {
              assert.doesNotMatch(
                data.robots ?? '',
                /noindex/u,
                `Indexable page ${urlPath} must not carry noindex`
              );
              assert.equal(data.canonical, `https://lody.ai${directoryPath(urlPath)}`);
              assert.equal(data.ogUrl, data.canonical);
            }
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
            assert.equal(data.lang, expectedHtmlLang(urlPath));
            assert.ok(data.headings.length > 0);
            if (/^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?docs(?:\/|$)/u.test(urlPath)) {
              assert.equal(data.headings.length, 1);
              assert.deepEqual(data.missingFragmentTargets, [], 'Docs anchors must resolve');
            }
            assert.ok(await page.locator('h1').first().isVisible());
            assert.ok(data.text.length > 80);
            if (
              /^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?docs(?:\/|$)/u.test(urlPath) ||
              /^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?blog\//u.test(urlPath)
            ) {
              assert.ok(data.articleText?.length > 40, 'Prerendered article body must be present');
            }
            assert.ok(!data.text.includes('Something went wrong!'));
            assert.ok(data.links.length > 0);
            idsByPath.set(normalize(urlPath), new Set(data.ids));
            for (const { href, rel } of data.linkDetails) {
              const url = new URL(href, page.url());
              if ([origin, 'https://lody.ai'].includes(url.origin)) {
                if (!href.startsWith('#')) {
                  assert.doesNotMatch(
                    normalize(url.pathname),
                    /^(?:\/(?:zh-hant|zh|ja|ko|es|fr|ru))?\/home$/u,
                    `Internal link on ${urlPath} must not target noindex /home: ${href}`
                  );
                }
                if (/^\/login(\/|$)/u.test(url.pathname)) {
                  const relTokens = (rel ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
                  assert.ok(
                    relTokens.includes('nofollow'),
                    `App-owned /login link on ${urlPath} must carry rel="nofollow": ${href}`
                  );
                }
              }
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
                if (url.hash.length > 1) {
                  hashLinks.push({
                    from: urlPath,
                    href,
                    targetPath: normalize(url.pathname),
                    id: decodeURIComponent(url.hash.slice(1)),
                    rawId: url.hash.slice(1),
                  });
                }
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
    await run('all internal #fragment targets resolve', async () => {
      const broken = [];
      for (const item of hashLinks) {
        const ids = idsByPath.get(item.targetPath);
        if (!ids || (!ids.has(item.id) && !ids.has(item.rawId))) {
          broken.push(item);
        }
      }
      assert.deepEqual(broken, []);
      return { checkedFragments: hashLinks.length };
    });
    await run('sitemap index and 8 locale sitemaps are published', async () => {
      const indexResponse = await fetch(`${origin}/sitemap.xml`, { redirect: 'manual' });
      assert.equal(indexResponse.status, 200);
      const indexXml = await indexResponse.text();
      assert.match(indexXml, /<sitemapindex\b/u);
      const localeLocs = [...indexXml.matchAll(/<sitemap><loc>(.*?)<\/loc>/gu)].map(
        (match) => match[1]
      );
      assert.equal(localeLocs.length, 8);
      for (const loc of localeLocs) {
        const pathname = new URL(loc).pathname;
        const response = await fetch(`${origin}${pathname}`, { redirect: 'manual' });
        assert.equal(response.status, 200, `Missing published sitemap: ${pathname}`);
        const xml = await response.text();
        assert.match(xml, /<urlset\b/u);
      }
      return { localeSitemaps: localeLocs.length };
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
    '/docs/compare/share-link-vs-live-handoff',
    '/zh/docs/compare/share-link-vs-live-handoff',
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
          .getByRole('button', {
            name: /Toggle color theme|切换配色主题|Switch to (light|dark) theme/u,
          })
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
        assert.deepEqual(
          after.jsonLd,
          before.jsonLd,
          'Hydration must preserve single non-duplicated JSON-LD payload'
        );
        if (
          /^(?:\/|\/zh|\/blog(?:\/.+)?|\/zh\/blog(?:\/.+)?|\/(?:zh\/)?docs\/compare\/.+)$/u.test(
            urlPath
          )
        ) {
          assert.equal(after.jsonLd.length, 1, `Expected 1 JSON-LD script on ${urlPath}`);
        }
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
    const articleScript = scripts.find((s) =>
      /\/(quickstart|introducing-lody|share-link-vs-live-handoff)-/u.test(s)
    );
    if (/quickstart|introducing-lody|share-link-vs-live-handoff/u.test(urlPath))
      assert.ok(articleScript);
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
  for (const urlPath of ['/', '/docs/compare/share-link-vs-live-handoff']) {
    const before = await baseline(urlPath);
    const edgeContext = await newContext();
    await edgeContext.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('failed');
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      const html = (await response.text())
        .replace(
          '<head>',
          '<head><script data-edge-probe="prepend">window.__edgePrepend=1;</script>'
        )
        .replace(
          '</head>',
          '<script data-edge-probe="append">window.__edgeAppend=1;</script></head>'
        );
      await route.fulfill({ response, body: html });
    });
    try {
      await run(`edge head script injection ${urlPath}`, async () => {
        const page = await edgeContext.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(origin + directoryPath(urlPath));
        await settled(page);
        assert.ok(
          await page.evaluate(
            () =>
              window.__edgePrepend === 1 &&
              window.__edgeAppend === 1 &&
              Object.keys(document).some((key) => key.startsWith('__reactContainer$'))
          )
        );
        const after = await snapshot(page);
        assert.deepEqual(after.jsonLd, before.jsonLd);
        assert.equal(after.jsonLd.length, 1);
        assert.deepEqual(pageErrors, []);
      });
    } finally {
      await edgeContext.close();
    }
  }
  const attributionContext = await newContext();
  try {
    await run(
      'organic landing attribution across SPA navigation to download and login',
      async () => {
        const page = await attributionContext.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(origin + '/docs/quickstart/', {
          referer: 'https://www.google.com/search?q=lody+coding+agents',
        });
        await settled(page);

        const bootCommands = await page.evaluate(() =>
          (window.dataLayer ?? []).map((entry) => Array.from(entry).slice(0, 3))
        );
        assert.equal(bootCommands[0]?.[0], 'consent');
        assert.equal(bootCommands[0]?.[1], 'default');
        assert.equal(bootCommands[0]?.[2]?.analytics_storage, 'denied');
        assert.equal(bootCommands[1]?.[0], 'consent');
        assert.equal(bootCommands[1]?.[1], 'default');
        assert.equal(bootCommands[1]?.[2]?.analytics_storage, 'granted');
        assert.ok(
          bootCommands.some((cmd) => cmd[0] === 'config' && cmd[1] === 'G-JSXEKG6RRV'),
          'gtag config must be queued synchronously before SPA navigation'
        );

        await clickTo(page, page.locator('#nd-page a[href="/download/"]').first(), '/download');

        await page.evaluate(() => {
          document.addEventListener(
            'click',
            (event) => {
              const anchor =
                event.target instanceof Element ? event.target.closest('a[href]') : null;
              if (
                anchor &&
                (anchor.getAttribute('href')?.startsWith('https://updates.lody.ai/') ||
                  anchor.getAttribute('href') === '/login')
              ) {
                event.stopPropagation();
                event.preventDefault();
              }
            },
            { capture: false }
          );
        });

        await page
          .locator('a[href*="Lody-latest-arm64.dmg"], a[href*="-arm64.dmg"]')
          .first()
          .click();
        await page.locator('.download-card a[href="/login"]').first().click();

        const events = await page.evaluate(() =>
          (window.dataLayer ?? [])
            .map((entry) => Array.from(entry))
            .filter((entry) => entry[0] === 'event')
        );

        const downloadEvent = events.find((entry) => entry[1] === 'download_installer');
        assert.ok(downloadEvent, 'Expected download_installer conversion event in dataLayer');
        assert.equal(downloadEvent[2]?.entry_page, '/docs/quickstart/');
        assert.equal(downloadEvent[2]?.source_page, '/download/');
        assert.equal(downloadEvent[2]?.traffic_channel, 'organic_search');
        assert.equal(downloadEvent[2]?.referrer_host, 'www.google.com');
        assert.equal(downloadEvent[2]?.platform, 'mac');
        assert.equal(downloadEvent[2]?.arch, 'arm64');
        assert.equal(downloadEvent[2]?.installer_format, 'dmg');
        assert.equal(downloadEvent[2]?.release_channel, 'stable');
        assert.equal(downloadEvent[2]?.cta_surface, 'download_card');
        assert.equal(downloadEvent[2]?.transport_type, 'beacon');

        const loginEvent = events.find((entry) => entry[1] === 'open_web_app');
        assert.ok(loginEvent, 'Expected open_web_app conversion event in dataLayer');
        assert.equal(loginEvent[2]?.entry_page, '/docs/quickstart/');
        assert.equal(loginEvent[2]?.source_page, '/download/');
        assert.equal(loginEvent[2]?.traffic_channel, 'organic_search');
        assert.equal(loginEvent[2]?.referrer_host, 'www.google.com');
        assert.equal(loginEvent[2]?.destination, '/login');
        assert.equal(loginEvent[2]?.cta_surface, 'download_card');
        assert.equal(loginEvent[2]?.transport_type, 'beacon');

        assert.deepEqual(pageErrors, []);
      }
    );
  } finally {
    await attributionContext.close();
  }
}

async function clickTo(page, link, destination) {
  await link.click();
  await page.waitForURL((url) => normalize(url.pathname) === destination);
  const expectedCanonical = destination || '/';
  await page.waitForFunction((expected) => {
    const canonical = document.querySelector('link[rel=canonical]')?.href;
    return canonical && (new URL(canonical).pathname.replace(/\/$/u, '') || '/') === expected;
  }, expectedCanonical);
  assert.ok(await page.locator('h1').first().isVisible());
  assert.equal(new URL(page.url()).pathname, directoryPath(destination));
  assert.equal(
    new URL((await snapshot(page)).canonical).pathname.replace(/\/$/u, '') || '/',
    destination || '/'
  );
}

const navName = (prefix, mobile) =>
  mobile
    ? prefix === '/zh'
      ? '移动端主导航'
      : 'Primary mobile'
    : prefix === '/zh'
      ? '主导航'
      : 'Primary';

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
              name: navName(prefix, mobile),
              exact: true,
            });
            await clickTo(page, nav.locator(`a[href="${prefix}/docs/"]`), `${prefix}/docs`);
            await clickTo(
              page,
              page.locator(`#nd-page a[href="${prefix}/docs/session-handoff/"]`).first(),
              `${prefix}/docs/session-handoff`
            );
            await page.goto(origin + prefix + '/blog');
            const article = page
              .locator(`main a[href^="${prefix}/blog/"]:not([href="${prefix}/blog/"])`)
              .first();
            const target = normalize(new URL(await article.getAttribute('href'), origin).pathname);
            await clickTo(page, article, target);
            await page.screenshot({
              path: path.join(
                artifactDir,
                `${prefix ? 'zh' : 'en'}-${mobile ? 'mobile' : 'desktop'}-no-js.png`
              ),
            });
            await clickTo(page, page.locator('a.site-nav__brand'), prefix || '/');
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
            .getByRole('navigation', { name: navName(prefix, true), exact: true })
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
            .getByRole('navigation', { name: navName(prefix, true), exact: true })
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
        for (const [urlPath, id] of [
          ['/docs/quickstart/', 'quick-start'],
          ['/zh/docs/quickstart/', '快速开始'],
        ]) {
          await run(
            `docs title anchor ${urlPath} ${mobile ? 'mobile' : 'desktop'} ${js ? 'hydrated' : 'no-js'}`,
            async () => {
              const page = await context.newPage();
              await page.goto(`${origin}${urlPath}#${encodeURIComponent(id)}`);
              if (js) await settled(page);
              assert.equal(await page.locator('h1').count(), 1);
              assert.equal(await page.locator('h1').getAttribute('id'), id);
              await anchorPosition(page, id);
              await page.reload();
              if (js) await settled(page);
              await anchorPosition(page, id);
              await page.close();
            }
          );
        }
        for (const [source, label, destination, id] of [
          ['/docs/', 'Daemon Mode', '/docs/cli', 'daemon-mode'],
          ['/zh/docs/local-project/', 'CLI 命令', '/zh/docs/cli', 'project-命令'],
          [
            '/es/docs/compare/share-link-vs-live-handoff/',
            'Bifurcar una sesión',
            '/es/docs/session',
            'bifurcar-una-sesión',
          ],
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
              if (destination.endsWith('/docs/cli')) {
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
              }
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
