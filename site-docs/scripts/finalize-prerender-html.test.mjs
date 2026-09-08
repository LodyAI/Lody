import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  documentOwnsPageStylesheet,
  finalizePrerenderHtml,
  injectLandingFirstPaintStyle,
  isCriticalModulePreloadHref,
  isLandingDocument,
  isLegalDocument,
  isPageOnlyStylesheetHref,
  isPricingDocument,
  stripLandingImagePreloads,
  stripNonCriticalModulePreload,
} from './finalize-prerender-html.mjs';

const sample = `<!DOCTYPE html><html><head>
<link rel="modulepreload" href="/assets/index-abc.js"/>
<link rel="modulepreload" href="/assets/react-CUp.js"/>
<link rel="modulepreload" href="/assets/react-dom-Cye.js"/>
<link rel="modulepreload" href="/assets/jsx-runtime-CFw.js"/>
<link rel="modulepreload" href="/assets/rolldown-runtime-DAX.js"/>
<link rel="modulepreload" href="/assets/landing-DLX.js"/>
<link rel="modulepreload" href="/assets/pricing-B2h.js"/>
<link rel="modulepreload" href="/assets/docs-P5r.js"/>
<link rel="stylesheet" href="/assets/index.css"/>
<link rel="preload" href="/_docs-assets/logo-96.png" as="image"/>
</head><body>
<script type="module" async="" src="/assets/index-abc.js"></script>
</body></html>`;

await test('critical runtime chunks stay modulepreloaded', () => {
  assert.equal(isCriticalModulePreloadHref('/assets/index-abc.js'), true);
  assert.equal(isCriticalModulePreloadHref('/assets/react-CUp.js'), true);
  assert.equal(isCriticalModulePreloadHref('/assets/react-dom-Cye.js'), true);
  assert.equal(isCriticalModulePreloadHref('assets/jsx-runtime-CFw.js'), true);
});

await test('route and page chunks are not critical', () => {
  assert.equal(isCriticalModulePreloadHref('/assets/landing-DLX.js'), false);
  assert.equal(isCriticalModulePreloadHref('/assets/pricing-B2h.js'), false);
  assert.equal(isCriticalModulePreloadHref('/assets/docs-P5r.js'), false);
  assert.equal(isCriticalModulePreloadHref('/assets/search-DPN.js'), false);
});

await test('stripNonCriticalModulePreload keeps runtime and drops route chunks', () => {
  const next = stripNonCriticalModulePreload(sample);
  assert.match(next, /index-abc\.js/u);
  assert.match(next, /react-CUp\.js/u);
  assert.match(next, /react-dom-Cye\.js/u);
  assert.match(next, /index\.css/u);
  assert.match(next, /logo-96\.png/u);
  assert.match(next, /type="module"/u);
  assert.doesNotMatch(next, /landing-DLX/u);
  assert.doesNotMatch(next, /pricing-B2h/u);
  assert.doesNotMatch(next, /docs-P5r/u);
});

const landingHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/assets/index.css"/>
<link rel="stylesheet" href="/assets/pricing-abc.css"/>
<link rel="preload" href="/_docs-assets/logo-96.png" as="image"/>
</head><body>
<h1 class="underwater-hero__title">Share coding agents</h1>
</body></html>`;

const docsHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/assets/index.css"/>
<link rel="stylesheet" href="/assets/legal-abc.css"/>
<link rel="stylesheet" href="/assets/pricing-abc.css"/>
</head><body><article class="prose"><p>Handoff</p></article></body></html>`;

const pricingHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/assets/index.css"/>
<link rel="stylesheet" href="/assets/pricing-abc.css"/>
<link rel="stylesheet" href="/assets/legal-abc.css"/>
</head><body>
<main class="landing pricing-page">
  <section class="pricing-hero"><h1>Pricing</h1></section>
</main>
</body></html>`;

const legalHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/assets/index.css"/>
<link rel="stylesheet" href="/assets/legal-abc.css"/>
<link rel="stylesheet" href="/assets/pricing-abc.css"/>
</head><body>
<main class="legal-page"><article class="legal-page__article">Privacy</article></main>
</body></html>`;

await test('landing documents are detected by the hero title', () => {
  assert.equal(isLandingDocument(landingHtml), true);
  assert.equal(isLandingDocument(docsHtml), false);
});

await test('page-only stylesheets are pricing and legal chunks', () => {
  assert.equal(isPageOnlyStylesheetHref('/assets/pricing-abc.css'), true);
  assert.equal(isPageOnlyStylesheetHref('/assets/legal-abc.css'), true);
  assert.equal(isPageOnlyStylesheetHref('/assets/index.css'), false);
});

await test('landing first paint inlines critical CSS and defers every stylesheet', () => {
  const next = finalizePrerenderHtml(landingHtml, '/* c */ .underwater-hero__title{color:red}');
  assert.match(next, /data-landing-first-paint/u);
  assert.match(next, /\.underwater-hero__title\{color:red\}/u);
  assert.match(next, /data-lody-defer-css/u);
  assert.match(next, /data-lody-apply-css/u);
  assert.doesNotMatch(next, /onload="this\.media='all'"/u);
  assert.match(next, /<noscript><link rel="stylesheet" href="\/assets\/index\.css"\/><\/noscript>/u);
  assert.doesNotMatch(next, /logo-96\.png/u);
});

await test('docs keep index.css render-blocking so reading chrome cannot FOUC', () => {
  const next = finalizePrerenderHtml(docsHtml);
  assert.doesNotMatch(next, /data-landing-first-paint/u);
  assert.doesNotMatch(next, /data-lody-defer-css/u);
  assert.match(next, /<link rel="stylesheet" href="\/assets\/index\.css"\/>/u);
  assert.match(next, /onload="this\.media='all'"/u);
  assert.match(next, /legal-abc\.css/u);
  assert.match(next, /pricing-abc\.css/u);
});

await test('pricing and legal documents are detected by their page roots', () => {
  assert.equal(isPricingDocument(pricingHtml), true);
  assert.equal(isPricingDocument(legalHtml), false);
  assert.equal(isPricingDocument(docsHtml), false);
  assert.equal(isLegalDocument(legalHtml), true);
  assert.equal(isLegalDocument(pricingHtml), false);
  assert.equal(isLegalDocument(docsHtml), false);
});

await test('a document owns only its own page stylesheet', () => {
  assert.equal(documentOwnsPageStylesheet(pricingHtml, '/assets/pricing-abc.css'), true);
  assert.equal(documentOwnsPageStylesheet(pricingHtml, '/assets/legal-abc.css'), false);
  assert.equal(documentOwnsPageStylesheet(legalHtml, '/assets/legal-abc.css'), true);
  assert.equal(documentOwnsPageStylesheet(legalHtml, '/assets/pricing-abc.css'), false);
  assert.equal(documentOwnsPageStylesheet(docsHtml, '/assets/pricing-abc.css'), false);
});

await test('pricing keeps its own sheet blocking and defers leaked legal CSS', () => {
  const next = finalizePrerenderHtml(pricingHtml);
  assert.match(next, /<link rel="stylesheet" href="\/assets\/index\.css"\/>/u);
  assert.match(next, /<link rel="stylesheet" href="\/assets\/pricing-abc\.css"\/>/u);
  assert.doesNotMatch(next, /<link media="print"[^>]*href="\/assets\/pricing-abc\.css"/u);
  assert.doesNotMatch(next, /data-lody-defer-css/u);
  assert.match(
    next,
    /<link media="print" onload="this\.media='all'" rel="stylesheet" href="\/assets\/legal-abc\.css"\/>/u
  );
});

await test('legal keeps its own sheet blocking and defers leaked pricing CSS', () => {
  const next = finalizePrerenderHtml(legalHtml);
  assert.match(next, /<link rel="stylesheet" href="\/assets\/index\.css"\/>/u);
  assert.match(next, /<link rel="stylesheet" href="\/assets\/legal-abc\.css"\/>/u);
  assert.doesNotMatch(next, /<link media="print"[^>]*href="\/assets\/legal-abc\.css"/u);
  assert.doesNotMatch(next, /data-lody-defer-css/u);
  assert.match(
    next,
    /<link media="print" onload="this\.media='all'" rel="stylesheet" href="\/assets\/pricing-abc\.css"\/>/u
  );
});

await test('landing first-paint sheet includes rotating-word and nav chrome', () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/landing-first-paint.css'), 'utf8');
  assert.match(css, /\.rw-viewport\b/u);
  assert.match(css, /\.rw-strip\b/u);
  assert.match(css, /\.rw-word\b/u);
  assert.match(css, /\.site-nav__link\b/u);
  assert.match(css, /\.site-nav__theme-toggle\b/u);
  assert.match(css, /\.site-nav__theme-track\b/u);
  assert.match(css, /\.underwater-landing \.site-nav\b/u);
  assert.match(css, /backdrop-filter:\s*none/u);
  assert.match(css, /\.underwater-bg__overlay\b[\s\S]*radial-gradient/u);
  assert.match(css, /\.underwater-btn__icon\b/u);
  assert.match(css, /\.underwater-btn__icon\b[\s\S]*?width:\s*1\.05rem/u);
  assert.match(css, /\.underwater-hero__scroll-hint\b[\s\S]*?display:\s*inline-flex/u);
  assert.match(css, /\.underwater-hero__lead\b[\s\S]*?203 46% 86%/u);
  assert.match(css, /\.site-nav__toggle\b[\s\S]*?landing-surface-2/u);
  const next = finalizePrerenderHtml(landingHtml, css);
  assert.match(next, /\.rw-viewport\{/u);
  assert.match(next, /\.site-nav__link\{/u);
  assert.match(next, /\.site-nav__theme-toggle\{/u);
  assert.match(next, /\.underwater-landing \.site-nav\{/u);
  assert.match(next, /\.underwater-bg__overlay\{[^}]*radial-gradient/u);
  assert.match(next, /\.underwater-btn__icon\{[^}]*width:1\.05rem/u);
  assert.match(next, /\.underwater-hero__scroll-hint\{[^}]*display:inline-flex/u);
  assert.match(next, /\.underwater-hero__lead\{[^}]*203 46% 86%/u);
  assert.match(next, /\.site-nav__toggle\{[^}]*landing-surface-2/u);
});

await test('injectLandingFirstPaintStyle is a no-op off the landing', () => {
  assert.equal(injectLandingFirstPaintStyle(docsHtml, 'h1{}'), docsHtml);
});

await test('stripLandingImagePreloads leaves docs preloads alone', () => {
  const withLogo = docsHtml.replace(
    '</head>',
    '<link rel="preload" href="/_docs-assets/logo-96.png" as="image"/></head>'
  );
  assert.equal(stripLandingImagePreloads(withLogo), withLogo);
});
