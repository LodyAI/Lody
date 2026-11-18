import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blocksHtmlPreviewFrameNavigation,
  isHtmlPreviewPermissionRequester,
  LocalHtmlPreviewSites,
  openLocalHtmlPreview
} from './local-html-preview.ts'

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

void test('a nested page can load workspace assets only with the workspace resource grant', async (t) => {
  const { dir, page } = await site(t)
  await mkdir(join(dir, 'shared'))
  await writeFile(join(dir, 'shared', 'app.mjs'), 'export default 42')
  const sites = new LocalHtmlPreviewSites()
  const request = {
    machineId: 'local',
    path: join(page, 'index.html'),
    workspaceRoot: dir,
    allowScripts: true
  }
  const limited = openLocalHtmlPreview(sites, 1, request, 'local')
  assert.equal((await get(sites, new URL('../shared/app.mjs', limited.url))).status, 404)
  const granted = openLocalHtmlPreview(
    sites,
    1,
    { ...request, allowWorkspaceResources: true },
    'local'
  )
  assert.equal(new URL(granted.url).pathname, '/page/index.html')
  const module = await get(sites, new URL('../shared/app.mjs', granted.url))
  assert.equal(await module.text(), 'export default 42')
  assert.equal((await get(sites, new URL('/page/.env', granted.url))).status, 404)
  const outside = openLocalHtmlPreview(
    sites,
    1,
    { ...request, allowWorkspaceResources: true, workspaceRoot: join(dir, 'shared') },
    'local'
  )
  assert.equal(outside.status, 'error')
})

void test('local HTML preview never leaves the page folder or exposes hidden files', async (t) => {
  const { dir, page } = await site(t)
  await symlink(join(dir, 'outside.txt'), join(page, 'link.txt'))
  // Visible names that resolve to hidden files or folders stay hidden.
  await symlink(join(page, '.env'), join(page, 'config.txt'))
  await mkdir(join(page, '.git'))
  await writeFile(join(page, '.git', 'config'), '[remote]')
  await symlink(join(page, '.git'), join(page, 'repo'))
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
    '/config.txt',
    '/repo/config',
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

void test('local HTML preview frames stay on preview content and get no permissions', () => {
  const preview = 'lody-html-preview://0123456789abcdef0123456789abcdef/index.html'
  // A preview page may move within previews, but not become a web page in Lody's window.
  assert.equal(blocksHtmlPreviewFrameNavigation(preview, 'https://example.com/login'), true)
  assert.equal(blocksHtmlPreviewFrameNavigation(preview, 'file:///etc/hosts'), true)
  assert.equal(blocksHtmlPreviewFrameNavigation(preview, 'javascript:alert(1)'), true)
  assert.equal(
    blocksHtmlPreviewFrameNavigation(
      preview,
      'lody-html-preview://0123456789abcdef0123456789abcdef/b.html'
    ),
    false
  )
  // Other frames (product UI, browser previews) keep their own navigation rules.
  assert.equal(
    blocksHtmlPreviewFrameNavigation('http://127.0.0.1:5173/', 'https://example.com/'),
    false
  )
  assert.equal(blocksHtmlPreviewFrameNavigation(null, 'https://example.com/'), false)

  assert.equal(isHtmlPreviewPermissionRequester(preview), true)
  assert.equal(isHtmlPreviewPermissionRequester(undefined, 'lody-html-preview://abc'), true)
  assert.equal(isHtmlPreviewPermissionRequester('file:///app/index.html', 'file:///'), false)
  assert.equal(isHtmlPreviewPermissionRequester(undefined, null), false)
})
