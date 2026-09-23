import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rendererHtml = await readFile(new URL('./index.html', import.meta.url), 'utf8')
const devbarHtml = await readFile(new URL('./devbar.html', import.meta.url), 'utf8')

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

void test('renderer CSP allows reading preview object URLs for image export', () => {
  assert.ok(getDirectiveSources(rendererHtml, 'connect-src').includes('blob:'))
})

void test('renderer CSP allows the Codex reset forecast API', () => {
  assert.ok(getDirectiveSources(rendererHtml, 'connect-src').includes('https://codex-resets.com'))
})

void test('only the opt-in Devbar entry may load the loopback Hub bootstrap', () => {
  assert.ok(!getDirectiveSources(rendererHtml, 'script-src').includes('http://127.0.0.1:*'))
  assert.ok(getDirectiveSources(devbarHtml, 'script-src').includes('http://127.0.0.1:*'))
})

void test('Devbar may resolve official Hub icons without broadening the normal renderer', () => {
  assert.ok(
    !getDirectiveSources(rendererHtml, 'connect-src').includes('https://api.iconify.design')
  )
  assert.ok(getDirectiveSources(devbarHtml, 'connect-src').includes('https://api.iconify.design'))
})
