import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Keep in sync with `lib/module-preload.ts`. */
export function isCriticalModulePreloadHref(href) {
  return /(?:^|\/)(?:index|rolldown-runtime|react-dom|react|jsx-runtime|preload-helper)-[^/]+\.js(?:\?|$)/u.test(
    href
  );
}

/**
 * Vite / TanStack prerender injects `<link rel="modulepreload">` for every
 * statically discovered route chunk. That list is identical on the homepage
 * and every docs URL, so first paint competes with landing/pricing/blog JS
 * the visitor has not asked for.
 *
 * Keep only the hydration runtime. The entry `<script type="module">` still
 * loads; the browser fetches the current route through the module graph.
 * Client navigation keeps `defaultPreload: 'intent'`.
 */

export function stripNonCriticalModulePreload(html) {
  return html.replace(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/giu, (tag) => {
    const href = /(?:^|\s)href=["']([^"']+)["']/iu.exec(tag)?.[1] ?? '';
    return isCriticalModulePreloadHref(href) ? tag : '';
  });
}

export function isLandingDocument(html) {
  return html.includes('underwater-hero__title');
}

export function isPricingDocument(html) {
  return /\bpricing-page\b/.test(html) || /\bpricing-hero\b/.test(html);
}

export function isLegalDocument(html) {
  return /\blegal-page\b/.test(html);
}

const PRICING_STYLESHEET = /(?:^|\/)pricing-[^/]+\.css(?:\?|$)/u;
const LEGAL_STYLESHEET = /(?:^|\/)legal-[^/]+\.css(?:\?|$)/u;

export function isPageOnlyStylesheetHref(href) {
  return PRICING_STYLESHEET.test(href) || LEGAL_STYLESHEET.test(href);
}

export function documentOwnsPageStylesheet(html, href) {
  if (PRICING_STYLESHEET.test(href)) return isPricingDocument(html);
  if (LEGAL_STYLESHEET.test(href)) return isLegalDocument(html);
  return false;
}

function stylesheetHref(tag) {
  return /(?:^|\s)href=["']([^"']+)["']/iu.exec(tag)?.[1] ?? '';
}

/**
 * Landing: download at print priority, apply after the first painted frame so
 * the inlined first-screen CSS can become LCP. That inlined sheet must already
 * match final hero/nav layout, background, and type — applying the bundle must
 * not restyle first-screen chrome.
 *
 * Docs and other pages: only unused leaked page-only sheets are deferred, and
 * they apply on load. A pricing or legal document keeps its own
 * `pricing-*.css` / `legal-*.css` render-blocking. `index-*.css` stays
 * render-blocking so reading chrome cannot FOUC.
 */
export function deferStylesheetTag(tag, { applyAfterPaint } = { applyAfterPaint: false }) {
  if (/data-lody-defer-css/iu.test(tag) || /media=["']print["']/iu.test(tag)) return tag;
  const stripped = tag.replace(/\smedia=["'][^"']*["']/iu, '');
  const deferred = applyAfterPaint
    ? stripped.replace(/<link\b/iu, '<link media="print" data-lody-defer-css')
    : stripped.replace(/<link\b/iu, '<link media="print" onload="this.media=\'all\'"');
  return `${deferred}<noscript>${tag}</noscript>`;
}

export function deferNonCriticalStylesheets(html) {
  const landing = isLandingDocument(html);
  return html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/giu, (tag) => {
    if (landing) return deferStylesheetTag(tag, { applyAfterPaint: true });
    const href = stylesheetHref(tag);
    if (isPageOnlyStylesheetHref(href) && !documentOwnsPageStylesheet(html, href)) {
      return deferStylesheetTag(tag, { applyAfterPaint: false });
    }
    return tag;
  });
}

export const APPLY_DEFERRED_CSS_SCRIPT =
  '<script data-lody-apply-css>(function(){function apply(){var n=document.querySelectorAll("link[data-lody-defer-css]");for(var i=0;i<n.length;i++)n[i].media="all";}function afterPaint(){requestAnimationFrame(function(){requestAnimationFrame(apply);});}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",afterPaint);else afterPaint();})();</script>';

export function injectApplyDeferredCssScript(html) {
  if (/data-lody-apply-css/u.test(html) || !/data-lody-defer-css/u.test(html)) return html;
  return html.replace(/<\/head>/iu, `${APPLY_DEFERRED_CSS_SCRIPT}</head>`);
}

export function stripLandingImagePreloads(html) {
  if (!isLandingDocument(html)) return html;
  return html.replace(/<link\b[^>]*\brel=["']preload["'][^>]*>/giu, (tag) => {
    return /\bas=["']image["']/iu.test(tag) ? '' : tag;
  });
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([{}:;,])\s*/gu, '$1')
    .trim();
}

export function injectLandingFirstPaintStyle(html, css) {
  if (!isLandingDocument(html) || /data-landing-first-paint/u.test(html)) return html;
  const compact = minifyCss(css);
  if (!compact) return html;
  const style = `<style data-landing-first-paint>${compact}</style>`;
  return html.replace(/<head([^>]*)>/iu, `<head$1>${style}`);
}

export function finalizePrerenderHtml(html, landingCss = '') {
  let next = stripNonCriticalModulePreload(html);
  next = stripLandingImagePreloads(next);
  next = injectLandingFirstPaintStyle(next, landingCss);
  next = deferNonCriticalStylesheets(next);
  next = injectApplyDeferredCssScript(next);
  return next;
}

function walkHtmlFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const next = path.join(dir, name);
    const info = statSync(next);
    if (info.isDirectory()) {
      walkHtmlFiles(next, files);
      continue;
    }
    if (name.endsWith('.html') && name !== '404.html') {
      files.push(next);
    }
  }
  return files;
}

export function finalizePrerenderHtmlTree(clientRoot) {
  const landingCss = readFileSync(path.join(packageRoot, 'app/landing-first-paint.css'), 'utf8');
  const files = walkHtmlFiles(clientRoot);
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const next = finalizePrerenderHtml(html, landingCss);
    if (next !== html) {
      writeFileSync(file, next);
    }
  }
  return files.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const clientRoot = path.join(packageRoot, 'out', 'client');
  const count = finalizePrerenderHtmlTree(clientRoot);
  console.log(`Finalized modulepreload on ${count} prerendered HTML files`);
}
