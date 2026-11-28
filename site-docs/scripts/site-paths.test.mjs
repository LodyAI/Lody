import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { structure } from 'fumadocs-core/mdx-plugins';
import { collectSitePaths, isSitemapPath, localePrefix, SITE_LOCALES } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSidebarEntries(dir) {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!Array.isArray(meta.pages)) {
    throw new Error(`${metaPath} must contain a pages array`);
  }
  if (meta.pages.includes('...') || meta.pages.includes('z...a')) {
    throw new Error(
      `${metaPath} uses a rest placeholder; unlisted folders would enter the sidebar`
    );
  }

  return meta.pages.flatMap((item) => {
    if (typeof item !== 'string' || item.startsWith('---')) return [];
    const itemPath = path.join(dir, item);
    if (existsSync(itemPath) && statSync(itemPath).isDirectory()) {
      return collectSidebarEntries(itemPath);
    }
    return [item];
  });
}

await test('prerender paths include static and 404 documents for all 8 locales', () => {
  const paths = collectSitePaths(packageRoot);
  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    assert.ok(paths.includes(prefix || '/'), `Missing root for ${locale}`);
    assert.ok(paths.includes(`${prefix}/docs`), `Missing docs root for ${locale}`);
    assert.ok(paths.includes(`${prefix}/download/nightly`), `Missing nightly for ${locale}`);
    assert.ok(paths.includes(`${prefix}/404`), `Missing 404 for ${locale}`);
    assert.ok(paths.includes(`${prefix}/home`), `Missing home for ${locale}`);
  }
});

await test('compare docs are prerendered even when omitted from sidebar meta', () => {
  const paths = collectSitePaths(packageRoot);
  assert.ok(paths.includes('/docs/compare/share-link-vs-live-handoff'));
  assert.ok(paths.includes('/zh/docs/compare/share-link-vs-live-handoff'));
  assert.equal(paths.includes('/docs/share-link-vs-live-handoff'), false);

  const docsEn = path.join(packageRoot, 'content/docs/en');
  const rootMeta = JSON.parse(readFileSync(path.join(docsEn, 'meta.json'), 'utf8'));
  const guidesMeta = JSON.parse(readFileSync(path.join(docsEn, '(guides)/meta.json'), 'utf8'));
  const sidebar = collectSidebarEntries(docsEn);
  assert.equal(rootMeta.pages.includes('compare'), false);
  assert.equal(guidesMeta.pages.includes('share-link-vs-live-handoff'), false);
  assert.equal(sidebar.includes('compare'), false);
  assert.equal(sidebar.includes('share-link-vs-live-handoff'), false);
});

await test('sitemap omits compatibility homes and 404 documents for all 8 locales', () => {
  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    assert.equal(isSitemapPath(prefix || '/'), true);
    assert.equal(isSitemapPath(`${prefix}/docs`), true);
    assert.equal(isSitemapPath(`${prefix}/home`), false);
    assert.equal(isSitemapPath(`${prefix}/404`), false);
  }
});

await test('site links preserve query, fragment, files and off-site/app destinations', async () => {
  const { siteHref, absoluteSiteUrl, absolutePageUrl } = await import('../lib/site-url.mjs');
  for (const [input, expected] of [
    ['/docs', '/docs/'],
    ['/docs/cli#daemon-mode', '/docs/cli/#daemon-mode'],
    ['/zh/docs/cli?from=docs#daemon-模式', '/zh/docs/cli/?from=docs#daemon-模式'],
    ['/zh', '/zh/'],
    ['/zh-hant', '/zh-hant/'],
    ['/zh-hant/docs/quickstart', '/zh-hant/docs/quickstart/'],
    ['/ja', '/ja/'],
    ['/ja/docs/quickstart', '/ja/docs/quickstart/'],
    ['/ko/price', '/ko/price/'],
    ['/es/download/nightly', '/es/download/nightly/'],
    ['/fr/blog/introducing-lody', '/fr/blog/introducing-lody/'],
    ['/ru/privacy', '/ru/privacy/'],
    ['/zh/docs/quickstart/', '/zh/docs/quickstart/'],
    ['/changelog/20260929-0.102.0', '/changelog/20260929-0.102.0/'],
    [
      '/zh/changelog/20260905-0.91.1?from=docs#fixes',
      '/zh/changelog/20260905-0.91.1/?from=docs#fixes',
    ],
    ['/docs/guide?next=a%2Fb&x=1#one?two', '/docs/guide/?next=a%2Fb&x=1#one?two'],
    ['https://lody.ai/blog/introducing-lody#intro', 'https://lody.ai/blog/introducing-lody/#intro'],
  ]) {
    assert.equal(siteHref(input), expected);
    assert.equal(siteHref(expected), expected);
    assert.equal(absoluteSiteUrl(input), new URL(expected, 'https://lody.ai').toString());
  }
  for (const href of [
    '/og-image.png',
    '/docs/guide.pdf?download=1#page=2',
    '/rss.xml',
    '/rss-ja.xml',
    '/llms-full.txt',
    '/_docs-assets/extensionless-image',
    '/assets/runtime.js',
    '/login?next=/docs',
    '/app',
    '/zha',
    '/japan',
    '#section',
    '?query=1',
    '../guide',
    '//example.com/docs',
    'mailto:hello@example.com',
    'https://example.com/docs',
    'https://updates.lody.ai/Lody-latest.dmg',
  ])
    assert.equal(siteHref(href), href);
  // Callers that know a URL is a page do not guess from extensions at all.
  assert.equal(absolutePageUrl('/docs/package.json'), 'https://lody.ai/docs/package.json/');
});

await test('generated sitemap index and 8 locale sitemaps use canonical directory URLs with real lastmod', async () => {
  const { execFileSync } = await import('node:child_process');
  const { detectPathLocale } = await import('./site-paths.mjs');
  const { sitemapFilenameForLocale } = await import('./generate-sitemap.mjs');

  execFileSync(process.execPath, [path.join(packageRoot, 'scripts/generate-sitemap.mjs')]);
  const indexXml = readFileSync(path.join(packageRoot, 'public/sitemap.xml'), 'utf8');
  assert.match(indexXml, /<sitemapindex\b/u);
  assert.doesNotMatch(indexXml, /<urlset\b/u);

  const indexEntries = [
    ...indexXml.matchAll(
      /<sitemap><loc>(.*?)<\/loc>(?:<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>)?<\/sitemap>/gu
    ),
  ].map((match) => ({ loc: match[1], lastmod: match[2] }));

  assert.deepEqual(
    indexEntries.map((entry) => entry.loc),
    SITE_LOCALES.map((locale) => `https://lody.ai/${sitemapFilenameForLocale(locale)}`)
  );

  const allPaths = collectSitePaths(packageRoot).filter(isSitemapPath);
  const seenUrls = new Set();

  for (const [index, locale] of SITE_LOCALES.entries()) {
    const filename = sitemapFilenameForLocale(locale);
    const localeXml = readFileSync(path.join(packageRoot, 'public', filename), 'utf8');
    assert.match(localeXml, /<urlset\b/u);

    const urlEntries = [
      ...localeXml.matchAll(
        /<url><loc>(.*?)<\/loc>(?:<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>)?<\/url>/gu
      ),
    ].map((match) => ({ loc: match[1], lastmod: match[2] }));

    const expectedPaths = allPaths.filter((p) => detectPathLocale(p) === locale);
    assert.deepEqual(
      urlEntries.map((entry) => entry.loc),
      expectedPaths.map((p) => `https://lody.ai${p === '/' ? p : `${p}/`}`)
    );

    let maxLocaleLastmod;
    for (const entry of urlEntries) {
      assert.equal(seenUrls.has(entry.loc), false, `Duplicate URL across sitemaps: ${entry.loc}`);
      seenUrls.add(entry.loc);
      const pathname = new URL(entry.loc).pathname;
      const isDatedCollectionPost =
        /^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?(?:blog|changelog)\/.+\/$/u.test(pathname);
      if (isDatedCollectionPost) {
        assert.ok(entry.lastmod, `Dated MDX entry must retain frontmatter lastmod: ${entry.loc}`);
      }
      if (entry.lastmod && (!maxLocaleLastmod || entry.lastmod > maxLocaleLastmod)) {
        maxLocaleLastmod = entry.lastmod;
      }
    }
    assert.equal(indexEntries[index].lastmod, maxLocaleLastmod);
  }

  assert.equal(seenUrls.size, allPaths.length);

  // Every published route must have 8-locale parity so hreflang alternates never 404.
  const { stripLocalePrefix } = await import('./site-paths.mjs');
  const basePathsByLocale = new Map(SITE_LOCALES.map((locale) => [locale, new Set()]));
  for (const sitePath of allPaths) {
    const { locale, basePath } = stripLocalePrefix(sitePath);
    basePathsByLocale.get(locale).add(basePath);
  }
  const enBasePaths = [...basePathsByLocale.get('en')].sort();
  for (const locale of SITE_LOCALES.slice(1)) {
    assert.deepEqual(
      [...basePathsByLocale.get(locale)].sort(),
      enBasePaths,
      `Locale "${locale}" sitemap routes must stay in 1:1 parity with English for valid hreflang`
    );
  }

  const dottedReleases = allPaths.filter((p) => /^\/(?:zh\/)?changelog\/.*\./u.test(p));
  assert.ok(dottedReleases.length > 0);
  for (const release of dottedReleases) {
    assert.ok(seenUrls.has(`https://lody.ai${release}/`));
  }
});

await test('sitemap lastmod derives from content changes and omits fabricated dates on shallow clones', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const { generateSitemaps } = await import('./generate-sitemap.mjs');

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'lody-sitemap-test-'));
  try {
    mkdirSync(path.join(tmpDir, 'content/docs/en'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'content/docs/ja'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'content/blog/en'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'content/pages/en'), { recursive: true });

    writeFileSync(
      path.join(tmpDir, 'content/docs/en/index.mdx'),
      '---\ntitle: Intro\ndescription: Docs\n---\n# Intro\n'
    );
    writeFileSync(
      path.join(tmpDir, 'content/docs/ja/index.mdx'),
      '---\ntitle: はじめに\ndescription: Docs\n---\n# Intro\n'
    );
    writeFileSync(
      path.join(tmpDir, 'content/blog/en/launch.mdx'),
      '---\ntitle: Launch\ndate: 2026-09-04\ndescription: Launch post\n---\nBody\n'
    );
    writeFileSync(
      path.join(tmpDir, 'content/pages/en/privacy.mdx'),
      '---\ntitle: Privacy\ndescription: Privacy\n---\nBody\n'
    );

    const gitDates = new Map([
      ['lib/landing-seo.ts', '2026-10-15'],
      ['content/docs/en/index.mdx', '2026-09-20'],
      ['content/docs/ja/index.mdx', '2026-11-02'],
      ['content/blog/en/launch.mdx', '2026-09-01'],
      ['content/pages/en/privacy.mdx', '2026-08-12'],
    ]);

    generateSitemaps(tmpDir, { gitLastmodByFile: gitDates });

    const enXml = readFileSync(path.join(tmpDir, 'public/sitemap-en.xml'), 'utf8');
    const jaXml = readFileSync(path.join(tmpDir, 'public/sitemap-ja.xml'), 'utf8');
    const indexXml = readFileSync(path.join(tmpDir, 'public/sitemap.xml'), 'utf8');

    assert.match(
      enXml,
      /<url><loc>https:\/\/lody\.ai\/<\/loc><lastmod>2026-10-15<\/lastmod><\/url>/u
    );
    assert.match(
      enXml,
      /<url><loc>https:\/\/lody\.ai\/docs\/<\/loc><lastmod>2026-09-20<\/lastmod><\/url>/u
    );
    assert.match(
      enXml,
      /<url><loc>https:\/\/lody\.ai\/blog\/launch\/<\/loc><lastmod>2026-09-04<\/lastmod><\/url>/u
    );
    assert.match(
      enXml,
      /<url><loc>https:\/\/lody\.ai\/blog\/<\/loc><lastmod>2026-09-04<\/lastmod><\/url>/u
    );
    assert.match(
      enXml,
      /<url><loc>https:\/\/lody\.ai\/privacy\/<\/loc><lastmod>2026-08-12<\/lastmod><\/url>/u
    );
    assert.match(
      jaXml,
      /<url><loc>https:\/\/lody\.ai\/ja\/docs\/<\/loc><lastmod>2026-11-02<\/lastmod><\/url>/u
    );
    assert.match(
      indexXml,
      /<sitemap><loc>https:\/\/lody\.ai\/sitemap-en\.xml<\/loc><lastmod>2026-10-15<\/lastmod><\/sitemap>/u
    );
    assert.match(
      indexXml,
      /<sitemap><loc>https:\/\/lody\.ai\/sitemap-ja\.xml<\/loc><lastmod>2026-11-02<\/lastmod><\/sitemap>/u
    );

    // Without git history (e.g. shallow depth=1 clone), frontmatter dates survive
    // while undated pages omit <lastmod> instead of fabricating today's build date.
    generateSitemaps(tmpDir, { gitLastmodByFile: new Map() });
    const shallowEnXml = readFileSync(path.join(tmpDir, 'public/sitemap-en.xml'), 'utf8');
    assert.match(
      shallowEnXml,
      /<url><loc>https:\/\/lody\.ai\/blog\/launch\/<\/loc><lastmod>2026-09-04<\/lastmod><\/url>/u
    );
    assert.match(shallowEnXml, /<url><loc>https:\/\/lody\.ai\/<\/loc><\/url>/u);
    assert.match(shallowEnXml, /<url><loc>https:\/\/lody\.ai\/docs\/<\/loc><\/url>/u);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('git shallow clones (depth=1 and depth=2) skip boundary commits instead of fabricating lastmod', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { generateSitemaps } = await import('./generate-sitemap.mjs');

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'lody-sitemap-git-'));
  const originRepo = path.join(tmpRoot, 'origin');
  const depth1Repo = path.join(tmpRoot, 'depth1');
  const depth2Repo = path.join(tmpRoot, 'depth2');

  const git = (cwd, args, dateIso) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}),
      },
    });

  try {
    mkdirSync(path.join(originRepo, 'site-docs/content/docs/en'), { recursive: true });
    mkdirSync(path.join(originRepo, 'site-docs/content/blog/en'), { recursive: true });
    git(originRepo, ['init', '-b', 'main']);

    // Commit 1 (2026-01-01): initial docs/index, docs/other, and dated blog post.
    writeFileSync(
      path.join(originRepo, 'site-docs/content/docs/en/index.mdx'),
      '---\ntitle: Intro\ndescription: Docs\n---\n# Intro\n'
    );
    writeFileSync(
      path.join(originRepo, 'site-docs/content/docs/en/other.mdx'),
      '---\ntitle: Other\ndescription: Other\n---\n# Other\n'
    );
    writeFileSync(
      path.join(originRepo, 'site-docs/content/blog/en/launch.mdx'),
      '---\ntitle: Launch\ndate: 2026-01-01\ndescription: Launch\n---\nBody\n'
    );
    git(originRepo, ['add', '.']);
    git(originRepo, ['commit', '-m', 'init'], '2026-01-01T12:00:00Z');

    // Commit 2 (2026-01-02): touches only an unrelated README file.
    writeFileSync(path.join(originRepo, 'README.md'), 'touch 2\n');
    git(originRepo, ['add', '.']);
    git(originRepo, ['commit', '-m', 'touch readme'], '2026-01-02T12:00:00Z');

    // Commit 3 (2026-01-03): edits only docs/other.mdx.
    writeFileSync(
      path.join(originRepo, 'site-docs/content/docs/en/other.mdx'),
      '---\ntitle: Other\ndescription: Updated\n---\n# Other v2\n'
    );
    git(originRepo, ['add', '.']);
    git(originRepo, ['commit', '-m', 'update other'], '2026-01-03T12:00:00Z');

    // Full history: distinct per-file dates.
    generateSitemaps(path.join(originRepo, 'site-docs'));
    const fullXml = readFileSync(path.join(originRepo, 'site-docs/public/sitemap-en.xml'), 'utf8');
    assert.match(
      fullXml,
      /<url><loc>https:\/\/lody\.ai\/docs\/<\/loc><lastmod>2026-01-01<\/lastmod><\/url>/u
    );
    assert.match(
      fullXml,
      /<url><loc>https:\/\/lody\.ai\/docs\/other\/<\/loc><lastmod>2026-01-03<\/lastmod><\/url>/u
    );

    const originUrl = pathToFileURL(originRepo).href;

    // Shallow --depth=2: Commit 2 (2026-01-02) is the boundary commit.
    // Untouched docs/index.mdx must NOT be falsely stamped 2026-01-02;
    // docs/other.mdx (edited in Commit 3 after the boundary) keeps 2026-01-03;
    // blog/launch.mdx keeps its frontmatter date 2026-01-01.
    git(tmpRoot, ['clone', '--depth=2', originUrl, depth2Repo]);
    generateSitemaps(path.join(depth2Repo, 'site-docs'));
    const depth2Xml = readFileSync(
      path.join(depth2Repo, 'site-docs/public/sitemap-en.xml'),
      'utf8'
    );
    assert.match(depth2Xml, /<url><loc>https:\/\/lody\.ai\/docs\/<\/loc><\/url>/u);
    assert.match(
      depth2Xml,
      /<url><loc>https:\/\/lody\.ai\/docs\/other\/<\/loc><lastmod>2026-01-03<\/lastmod><\/url>/u
    );
    assert.match(
      depth2Xml,
      /<url><loc>https:\/\/lody\.ai\/blog\/launch\/<\/loc><lastmod>2026-01-01<\/lastmod><\/url>/u
    );

    // Shallow --depth=1: Commit 3 (HEAD) is itself a boundary commit.
    // Undated pages omit <lastmod>; dated blog post keeps frontmatter 2026-01-01.
    git(tmpRoot, ['clone', '--depth=1', originUrl, depth1Repo]);
    generateSitemaps(path.join(depth1Repo, 'site-docs'));
    const depth1Xml = readFileSync(
      path.join(depth1Repo, 'site-docs/public/sitemap-en.xml'),
      'utf8'
    );
    assert.match(depth1Xml, /<url><loc>https:\/\/lody\.ai\/docs\/<\/loc><\/url>/u);
    assert.match(depth1Xml, /<url><loc>https:\/\/lody\.ai\/docs\/other\/<\/loc><\/url>/u);
    assert.match(
      depth1Xml,
      /<url><loc>https:\/\/lody\.ai\/blog\/launch\/<\/loc><lastmod>2026-01-01<\/lastmod><\/url>/u
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

await test('robots.txt declares valid user-agent groups and canonical sitemap', () => {
  const raw = readFileSync(path.join(packageRoot, 'public/robots.txt'), 'utf8');
  const groups = new Map();
  const sitemaps = [];
  let currentAgents = [];
  let ruleEnded = false;

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.replace(/#.*$/u, '').trim();
    if (!trimmed) {
      currentAgents = [];
      ruleEnded = false;
      continue;
    }
    const sep = trimmed.indexOf(':');
    assert.ok(sep > 0, `Malformed robots.txt line: ${line}`);
    const field = trimmed.slice(0, sep).trim().toLowerCase();
    const value = trimmed.slice(sep + 1).trim();
    if (field === 'user-agent') {
      if (ruleEnded) {
        currentAgents = [];
        ruleEnded = false;
      }
      currentAgents.push(value);
      assert.equal(groups.has(value), false, `Duplicate User-agent group: ${value}`);
      groups.set(value, []);
    } else if (field === 'sitemap') {
      sitemaps.push(value);
    } else {
      assert.ok(currentAgents.length > 0, `Directive before User-agent: ${line}`);
      ruleEnded = true;
      for (const agent of currentAgents) {
        groups.get(agent).push({ field, value });
      }
    }
  }

  assert.equal(
    groups.has('Google-Other'),
    false,
    'Use official GoogleOther token, not Google-Other'
  );
  assert.deepEqual(groups.get('GoogleOther'), [{ field: 'allow', value: '/' }]);
  assert.deepEqual(groups.get('*'), [
    { field: 'content-signal', value: 'search=yes, ai-input=yes, ai-train=no' },
    { field: 'allow', value: '/' },
  ]);
  assert.deepEqual(sitemaps, ['https://lody.ai/sitemap.xml']);
});

function walkMdx(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMdx(full, out);
    else if (entry.name.endsWith('.mdx')) out.push(full);
  }
  return out;
}

function stripFencedCode(body) {
  return body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, '');
}

await test('all MDX internal routes, locale prefixes, and #fragment anchors resolve across 8 locales', () => {
  const validRoutes = new Set(
    collectSitePaths(packageRoot).filter(
      (p) => !/^\/(?:(?:zh-hant|zh|ja|ko|es|fr|ru)\/)?404$/u.test(p)
    )
  );
  const idsByRoute = new Map();
  const mdxRecords = [];

  for (const locale of SITE_LOCALES) {
    const prefix = localePrefix(locale);
    const collections = [
      [
        'docs',
        (rel) => {
          const slug = rel
            .replace(/\.mdx$/u, '')
            .split('/')
            .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
            .filter((seg) => seg !== 'index')
            .join('/');
          return slug ? `${prefix}/docs/${slug}` : `${prefix}/docs`;
        },
      ],
      ['blog', (rel) => `${prefix}/blog/${rel.replace(/\.mdx$/u, '')}`],
      ['changelog', (rel) => `${prefix}/changelog/${rel.replace(/\.mdx$/u, '')}`],
      ['pages', (rel) => `${prefix}/${rel.replace(/\.mdx$/u, '')}`],
    ];

    for (const [kind, toRoute] of collections) {
      const baseDir = path.join(packageRoot, 'content', kind, locale);
      for (const file of walkMdx(baseDir)) {
        const rel = path.relative(baseDir, file).replace(/\\/gu, '/');
        const route = toRoute(rel);
        const raw = readFileSync(file, 'utf8');
        const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/u);
        const body = fmMatch ? fmMatch[1] : raw;
        const ids = new Set(structure(body).headings.map((h) => h.id));
        const stripped = stripFencedCode(body);
        for (const m of stripped.matchAll(/\bid="([^"]+)"/gu)) {
          ids.add(m[1]);
          ids.add(decodeURIComponent(m[1]));
        }
        idsByRoute.set(route, ids);
        mdxRecords.push({
          file: path.relative(packageRoot, file),
          locale,
          prefix,
          route,
          stripped,
        });
      }
    }
  }

  const violations = [];
  for (const { file, locale, prefix, route, stripped } of mdxRecords) {
    const hrefs = [
      ...[...stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((m) => m[1]),
      ...[...stripped.matchAll(/\bhref="([^"]+)"/gu)].map((m) => m[1]),
    ];

    for (const href of hrefs) {
      if (
        href.startsWith('mailto:') ||
        href.startsWith('tel:') ||
        (href.startsWith('http') && !href.startsWith('https://lody.ai'))
      ) {
        continue;
      }
      const parsed = new URL(href, `https://lody.ai${route === '/' ? '/' : `${route}/`}`);
      const cleanPath = parsed.pathname.replace(/\/+$/u, '') || '/';

      if (
        cleanPath === '/login' ||
        cleanPath.startsWith('/_docs-assets/') ||
        cleanPath.startsWith('/assets/') ||
        existsSync(path.join(packageRoot, 'public', cleanPath))
      ) {
        continue;
      }

      if (/^(?:\/(?:zh-hant|zh|ja|ko|es|fr|ru))?\/home$/u.test(cleanPath)) {
        violations.push(`${file}: links to noindex compatibility route ${href}`);
        continue;
      }

      if (!validRoutes.has(cleanPath)) {
        violations.push(`${file}: broken internal route ${href} -> ${cleanPath}`);
        continue;
      }

      if (
        locale !== 'en' &&
        !href.startsWith('#') &&
        cleanPath !== prefix &&
        !cleanPath.startsWith(`${prefix}/`)
      ) {
        violations.push(`${file}: unlocalized internal link ${href} (expected ${prefix} prefix)`);
      }

      if (parsed.hash.length > 1) {
        const targetIds = idsByRoute.get(cleanPath);
        const decodedHash = decodeURIComponent(parsed.hash.slice(1));
        if (targetIds && !targetIds.has(decodedHash) && !targetIds.has(parsed.hash.slice(1))) {
          violations.push(
            `${file}: broken #fragment ${href} (missing #${decodedHash} on ${cleanPath})`
          );
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});
