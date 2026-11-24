import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rendererHtml = await readFile(new URL('./index.html', import.meta.url), 'utf8')
const devbarHtml = await readFile(new URL('./devbar.html', import.meta.url), 'utf8')
const prImageHtml = await readFile(new URL('./pr-image.html', import.meta.url), 'utf8')

function getDirectiveSources(html, name) {
  const content = html.match(
    /<meta\b(?=[^>]*\bhttp-equiv="Content-Security-Policy")[^>]*\bcontent="([^"]*)"/i
  )?.[1]
  assert.ok(content, 'renderer entry must define a Content-Security-Policy meta tag')

  const directive = content
    .split(';')
    .map((value) => value.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name)
  assert.ok(directive, `renderer CSP must define ${name}`)
  return directive.slice(1)
}

void test('the isolated PR image document can run its loader without broadening the main renderer', () => {
  const script = prImageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  const digest = createHash('sha256').update(script).digest('base64')
  assert.ok(getDirectiveSources(prImageHtml, 'script-src').includes(`'sha256-${digest}'`))
  assert.deepEqual(getDirectiveSources(prImageHtml, 'img-src'), ['https:'])
  assert.ok(!getDirectiveSources(rendererHtml, 'img-src').includes('https:'))
})

void test('renderer entries allow exactly the current inline boot shell script', async () => {
  const { createBootShellScript } =
    await import('../../../../packages/components/src/lib/boot-shell-script.ts')
  const digest = createHash('sha256').update(createBootShellScript()).digest('base64')
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(html.includes('<!-- lody:boot-shell-head -->'))
    assert.ok(html.includes('<div id="root"><!-- lody:boot-shell --></div>'))
    assert.ok(getDirectiveSources(html, 'script-src').includes(`'sha256-${digest}'`))
  }
})

void test('renderer entries may frame direct HTML previews but never load them as code or data', () => {
  for (const html of [rendererHtml, devbarHtml]) {
    assert.ok(getDirectiveSources(html, 'frame-src').includes('lody-html-preview:'))
    for (const directive of ['default-src', 'script-src', 'connect-src', 'img-src']) {
      assert.ok(!getDirectiveSources(html, directive).includes('lody-html-preview:'), directive)
    }
  }
})

void test('remote executable module bytes must match the authenticated catalog of this document and machine', async () => {
  const { openAuthenticatedPluginSource, observePluginCatalog } =
    await import('../main/services/plugin-catalog-evidence.ts')
  const { computeClientDigest, packClientBundle } = await import('@lody/shared/plugins/digest')
  const file = async () => new TextEncoder().encode('export default 1')
  const manifest = {
    id: 'example',
    sdk: '^1.0.0',
    version: '1.0.0',
    title: 'Example',
    client: 'client.js'
  }
  const bytes = await packClientBundle(manifest, file),
    digest = await computeClientDigest(manifest, file)
  const reader = {},
    doc = {}
  const catalog = (enabled) => ({
    type: 'plugin/catalog',
    installations: [{ manifest, enabled, clientDigest: digest, source: {kind: 'local', origin: 'dir'} }]
  })
  observePluginCatalog(reader, doc, 'a', catalog(true))
  const open = (r, d, m, data) => openAuthenticatedPluginSource(r, d, m, 'example', digest, data)
  assert.equal(open(reader, doc, 'a', bytes), 'export default 1')
  assert.throws(() => open({}, doc, 'a', bytes))
  assert.throws(() => open(reader, {}, 'a', bytes))
  assert.throws(() => open(reader, doc, 'b', bytes))
  const corrupt = bytes.slice()
  corrupt[corrupt.length - 1] ^= 1
  assert.throws(() => open(reader, doc, 'a', corrupt))
  observePluginCatalog(reader, doc, 'a', catalog(false))
  assert.throws(() => open(reader, doc, 'a', bytes))
})
