import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCriticalModulePreloadHref,
  resolveModulePreloadDependencies,
} from './module-preload.ts';

const pricingRouteDeps = [
  'assets/pricing-B2h.js',
  'assets/pricing-abc.css',
  'assets/react-CUp.js',
  'assets/legal-abc.css',
];

await test('HTML hosts keep only the hydration runtime', () => {
  assert.deepEqual(
    resolveModulePreloadDependencies('index.html', pricingRouteDeps, { hostType: 'html' }),
    ['assets/react-CUp.js']
  );
  assert.equal(isCriticalModulePreloadHref('assets/pricing-abc.css'), false);
});

await test('JS hosts keep route CSS so client nav is not unstyled', () => {
  // Client-side nav to /price: Vite wraps the lazy import and must still
  // load the extracted pricing sheet (and any leaked sibling CSS in deps).
  assert.deepEqual(
    resolveModulePreloadDependencies('assets/router.js', pricingRouteDeps, { hostType: 'js' }),
    pricingRouteDeps
  );
});

await test('JS hosts keep the route JS graph, not only critical runtime', () => {
  const jsOnly = ['assets/pricing-B2h.js', 'assets/react-CUp.js'];
  assert.deepEqual(
    resolveModulePreloadDependencies('assets/router.js', jsOnly, { hostType: 'js' }),
    jsOnly
  );
});

await test('unknown hosts keep deps so CSS is never dropped by accident', () => {
  assert.deepEqual(
    resolveModulePreloadDependencies('assets/router.js', pricingRouteDeps, {}),
    pricingRouteDeps
  );
});
