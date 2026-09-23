import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalize404Html, stripAppHydration } from './finalize-404-html.mjs';

const sample = `<!DOCTYPE html><html><head>
<title>Page not found | Lody</title>
<meta name="robots" content="noindex, follow"/>
<link rel="modulepreload" href="/assets/index-abc.js"/>
<link rel="stylesheet" href="/assets/index.css"/>
</head><body>
<main>Page not found</main>
<script class="$tsr" id="$tsr-stream-barrier">self.$_TSR={}</script>
<script type="module" async="" src="/assets/index-abc.js"></script>
</body></html>`;

await test('stripAppHydration removes router boot scripts and keeps markup', () => {
  const next = stripAppHydration(sample);
  assert.match(next, /Page not found \| Lody/u);
  assert.match(next, /index\.css/u);
  assert.doesNotMatch(next, /modulepreload/u);
  assert.doesNotMatch(next, /type="module"/u);
  assert.doesNotMatch(next, /\$tsr/u);
});

await test('finalize404Html rejects a homepage-canonical 404 document', () => {
  assert.throws(
    () =>
      finalize404Html(
        '<title>Page not found | Lody</title><meta name="robots" content="noindex, follow"/><link rel="canonical" href="https://lody.ai/"/>'
      ),
    /canonical/u
  );
});
