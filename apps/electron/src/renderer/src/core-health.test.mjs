import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { hasHealthyContent } from './core-health.ts'
const require = createRequire(
  new URL('../../../../../packages/components/package.json', import.meta.url)
)
const { JSDOM } = require('jsdom')

test('health follows workspace and session bootstrap, including recoverable missing sessions', () => {
  const root = new JSDOM('<main></main>').window.document.querySelector('main')
  const route = {
    pending: false,
    pathname: '/team/sessions/s1',
    workspace: 'team',
    sessionId: 's1'
  }
  assert.equal(hasHealthyContent(root, route), false)
  root.innerHTML =
    '<span data-core-workspace-ready="other"></span><div data-window-session-ready="s1"></div>'
  assert.equal(hasHealthyContent(root, route), false)
  root.firstChild.setAttribute('data-core-workspace-ready', 'team')
  assert.equal(hasHealthyContent(root, route), true)
  root.lastChild.setAttribute('data-window-requires-stream', 'true')
  assert.equal(hasHealthyContent(root, route), false)
  root.insertAdjacentHTML('beforeend', '<span data-window-session-stream-ready="s1"></span>')
  assert.equal(hasHealthyContent(root, route), true)
  assert.equal(hasHealthyContent(root, { ...route, pending: true }), false)
  root.insertAdjacentHTML('beforeend', '<div data-lody-boot-shell></div>')
  assert.equal(hasHealthyContent(root, route), false)
})

test('legitimate entry pages and empty workspace need no cloud connection', () => {
  const root = new JSDOM('<main></main>').window.document.querySelector('main')
  for (const pathname of ['/login', '/onboarding', '/workspace/create']) {
    root.innerHTML = `<div data-core-entry-ready="${pathname}"></div>`
    assert.equal(hasHealthyContent(root, { pathname, pending: false }), true)
    assert.equal(hasHealthyContent(root, { pathname: '/', pending: false }), false)
  }
  root.innerHTML = '<span data-core-workspace-ready="team"></span>'
  assert.equal(
    hasHealthyContent(root, { pathname: '/team/chat', workspace: 'team', pending: false }),
    true
  )
})
