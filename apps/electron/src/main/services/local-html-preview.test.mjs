import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalHtmlPreviewSites, openLocalHtmlPreview } from './local-html-preview.ts'

async function site(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lody-html-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const page = join(dir, 'page')
  await mkdir(join(page, 'assets'), { recursive: true })
  await writeFile(join(page, 'index.html'), '<link rel="stylesheet" href="assets/app.css">')
  await writeFile(join(page, 'assets', 'app.css'), 'body{color:red}')
  await writeFile(join(page, '.env'), 'SECRET=1')
  await writeFile(join(dir, 'outside.txt'), 'outside')
  return { dir, page }
}

const get = (sites, url) => sites.respond(new Request(url))
// Node's URL reports `null` for custom-scheme origins; Electron treats the
// registered standard scheme like http, where the token host is the origin.
const originOf = (url) => `lody-html-preview://${new URL(url).hostname}`

void test('local HTML preview serves the page and sibling assets from a private origin', async (t) => {
  const { page } = await site(t)
  const sites = new LocalHtmlPreviewSites()
  const opened = openLocalHtmlPreview(
    sites,
    1,
    { machineId: 'local', path: join(page, 'index.html'), allowScripts: false },
    'local'
  )
  assert.equal(opened.status, 'ok')
  const url = new URL(opened.url)
  assert.equal(url.protocol, 'lody-html-preview:')
  assert.match(url.hostname, /^[0-9a-f]{32}$/u)

  const html = await get(sites, opened.url)
  assert.equal(html.status, 200)
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(html.headers.get('cache-control'), 'no-store')
  assert.match(html.headers.get('content-security-policy'), /script-src 'none'/u)
  assert.match(await html.text(), /assets\/app\.css/u)

  const css = await get(sites, new URL('assets/app.css', opened.url).href)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal(await css.text(), 'body{color:red}')

  // Edits on disk show up on reload.
  await writeFile(join(page, 'index.html'), 'edited')
  assert.equal(await (await get(sites, opened.url)).text(), 'edited')
})

void test('local HTML preview with scripts allowed omits the script-blocking policy', async (t) => {
  const { page } = await site(t)
  const sites = new LocalHtmlPreviewSites()
  const opened = openLocalHtmlPreview(
    sites,
    1,
    { machineId: 'local', path: join(page, 'index.html'), allowScripts: true },
    'local'
  )
  const response = await get(sites, opened.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-security-policy'), null)
})

void test('local HTML preview never leaves the page folder or exposes hidden files', async (t) => {
  const { dir, page } = await site(t)
  await symlink(join(dir, 'outside.txt'), join(page, 'link.txt'))
  const sites = new LocalHtmlPreviewSites()
  const opened = openLocalHtmlPreview(
    sites,
    1,
    { machineId: 'local', path: join(page, 'index.html'), allowScripts: true },
    'local'
  )
  const origin = originOf(opened.url)
  for (const path of [
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/.env',
    '/link.txt',
    '/assets',
    '/'
  ]) {
    assert.equal((await get(sites, origin + path)).status, 404, path)
  }
  assert.equal((await get(sites, 'lody-html-preview://unknown/index.html')).status, 404)
  assert.equal(
    (await sites.respond(new Request(opened.url, { method: 'POST', body: 'x' }))).status,
    405
  )
})

void test('local HTML preview is limited to this machine, HTML files, and live owners', async (t) => {
  const { page } = await site(t)
  const sites = new LocalHtmlPreviewSites()
  const request = { machineId: 'local', path: join(page, 'index.html'), allowScripts: false }
  assert.equal(openLocalHtmlPreview(sites, 1, { ...request, machineId: 'remote' }, 'local'), null)
  assert.equal(openLocalHtmlPreview(sites, 1, request, null), null)
  assert.equal(
    openLocalHtmlPreview(sites, 1, { ...request, path: join(page, 'assets', 'app.css') }, 'local')
      .status,
    'error'
  )

  const first = openLocalHtmlPreview(sites, 1, request, 'local')
  const other = openLocalHtmlPreview(sites, 2, request, 'local')
  assert.notEqual(originOf(first.url), originOf(other.url))
  sites.releaseOwner(1)
  assert.equal((await get(sites, first.url)).status, 404)
  assert.equal((await get(sites, other.url)).status, 200)
})
