import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {
  MCP_APP_SANDBOX_CONTENT_SECURITY_POLICY,
  MCP_APP_SANDBOX_PROXY_SCRIPT,
  respondMcpAppSandbox
} from './mcp-app-sandbox.ts'

const QUOTA = 5 * 1024 * 1024

/** Runs the shipped proxy script against a minimal frame global. */
const loadProxy = () => {
  const posted = []
  const listeners = []
  const written = []
  const document = {
    open: () => written.push('open'),
    write: (html) => written.push(html),
    close: () => written.push('close')
  }
  const context = vm.createContext({
    DOMException,
    document,
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.push(listener)
    }
  })
  vm.runInContext('globalThis.window = globalThis', context)
  context.parent = {
    postMessage: (message) =>
      posted.push({
        // Copied out of the script's realm so it compares by value.
        message: structuredClone(message),
        storageReady: typeof context.localStorage?.getItem === 'function'
      })
  }
  vm.runInContext(MCP_APP_SANDBOX_PROXY_SCRIPT, context)
  const deliver = (html) => {
    for (const listener of listeners) {
      listener({
        source: context.parent,
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-resource-ready',
          params: { html }
        }
      })
    }
  }
  return { context, document, posted, written, deliver }
}

const assertQuotaError = (action) =>
  assert.throws(
    action,
    (error) => error instanceof DOMException && error.name === 'QuotaExceededError'
  )

void test('only the proxy document is served, never an arbitrary path, host or method', () => {
  for (const request of [
    new Request('lody-mcp-app://sandbox/other'),
    new Request('lody-mcp-app://elsewhere/'),
    new Request(`lody-mcp-app://m${'0123456789abcdef'.repeat(2)}/`),
    new Request('lody-mcp-app://sandbox/', { method: 'POST', body: '<p>x</p>' })
  ]) {
    assert.equal(respondMcpAppSandbox(request).status, 404, request.url)
  }
})

void test('the proxy carries its own bounded policy and no inherited privileges', () => {
  const response = respondMcpAppSandbox(new Request('lody-mcp-app://sandbox/'))
  assert.equal(response.status, 200)
  const policy = response.headers.get('Content-Security-Policy')
  assert.equal(policy, MCP_APP_SANDBOX_CONTENT_SECURITY_POLICY)
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /object-src 'none'/)
  assert.doesNotMatch(policy, /unsafe-eval|http:|\*/)
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8')
})

void test('the proxy admits secure WebSockets for connections only', () => {
  const directives = new Map(
    MCP_APP_SANDBOX_CONTENT_SECURITY_POLICY.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/u)
      return [name, sources]
    })
  )
  assert.deepEqual(directives.get('connect-src'), ['https:', 'wss:'])
  for (const [name, sources] of directives) {
    if (name !== 'connect-src') assert.ok(!sources.includes('wss:'), name)
  }
})

void test('memory storage is in place before the proxy reports ready and outlives the app document', () => {
  const { context, posted, written, deliver } = loadProxy()
  assert.deepEqual(posted, [
    {
      message: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} },
      storageReady: true
    }
  ])
  context.localStorage.setItem('kept', '1')
  deliver('<p>app</p>')
  assert.deepEqual(written, ['open', '<p>app</p>', 'close'])
  assert.equal(vm.runInContext("localStorage.getItem('kept')", context), '1')
})

void test('memory storage implements the Storage methods', () => {
  const { localStorage: storage } = loadProxy().context
  assert.equal(storage.length, 0)
  assert.equal(storage.getItem('missing'), null)
  storage.setItem('a', 1)
  storage.setItem('b', { toString: () => 'two' })
  assert.equal(storage.getItem('a'), '1')
  assert.equal(storage.getItem('b'), 'two')
  assert.equal(storage.length, 2)
  assert.equal(storage.key(0), 'a')
  assert.equal(storage.key(1), 'b')
  assert.equal(storage.key(2), null)
  assert.equal(storage.key(-1), null)
  storage.removeItem('missing')
  assert.equal(storage.length, 2)
  storage.removeItem('a')
  assert.equal(storage.getItem('a'), null)
  assert.equal(storage.length, 1)
  storage.clear()
  assert.equal(storage.length, 0)
  assert.equal(storage.key(0), null)
})

void test('memory storage exposes items as properties, like a Storage object', () => {
  const { localStorage: storage } = loadProxy().context
  storage.first = 1
  storage.setItem('second', JSON.stringify({ n: [1, 2] }))
  assert.equal(storage.first, '1')
  assert.equal(storage.getItem('first'), '1')
  assert.ok('first' in storage)
  assert.ok(!('absent' in storage))
  assert.equal(storage.absent, undefined)
  assert.deepEqual(Object.keys(storage), ['first', 'second'])
  assert.deepEqual(JSON.parse(JSON.stringify(storage)), { first: '1', second: '{"n":[1,2]}' })
  assert.deepEqual(JSON.parse(storage.second), { n: [1, 2] })
  assert.ok(delete storage.first)
  assert.equal(storage.getItem('first'), null)
  assert.equal(storage.length, 1)
})

void test('Storage members win over items with the same name', () => {
  const { localStorage: storage } = loadProxy().context
  storage.setItem('getItem', 'x')
  storage.setItem('length', 'y')
  storage.setItem('key', 'z')
  storage.setItem('plain', 'p')
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(typeof storage.key, 'function')
  assert.equal(storage.getItem('getItem'), 'x')
  assert.equal(storage.getItem('length'), 'y')
  assert.equal(storage.length, 4)
  assert.deepEqual(Object.keys(storage), ['plain'])
  assert.deepEqual(Object.getOwnPropertyNames(storage), ['plain'])
  // Assignment stores an item; the member stays.
  storage.getItem = 'assigned'
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(storage.getItem('getItem'), 'assigned')
  assert.ok(delete storage.setItem)
  assert.equal(typeof storage.setItem, 'function')
})

void test('symbol properties are ordinary properties, never items', () => {
  const { localStorage: storage } = loadProxy().context
  const tag = Symbol('tag')
  assert.equal(storage[Symbol.iterator], undefined)
  storage[tag] = 1
  assert.equal(storage[tag], 1)
  assert.equal(storage.length, 0)
  assert.deepEqual(Object.keys(storage), [])
  assert.ok(Object.getOwnPropertySymbols(storage).includes(tag))
})

void test('memory storage rejects writes past 5 MiB of key and value characters', () => {
  const { localStorage: storage } = loadProxy().context
  storage.setItem('big', 'x'.repeat(QUOTA - 'big'.length))
  assertQuotaError(() => storage.setItem('c', ''))
  assertQuotaError(() => {
    storage.c = 'v'
  })
  assertQuotaError(() => storage.setItem('big', 'x'.repeat(QUOTA)))
  assert.equal(storage.length, 1)
  assert.equal(storage.getItem('big').length, QUOTA - 'big'.length)
  // Replacing an item counts only its new size.
  storage.setItem('big', 'small')
  storage.setItem('c', 'v')
  assert.equal(storage.getItem('c'), 'v')
  storage.removeItem('big')
  storage.setItem('again', 'x'.repeat(QUOTA - 'again'.length - 'c'.length - 'v'.length))
  assert.equal(storage.length, 2)
})

void test('localStorage and sessionStorage are separate stores', () => {
  const { context } = loadProxy()
  context.localStorage.setItem('k', 'local')
  context.sessionStorage.setItem('k', 'session')
  assert.equal(context.localStorage.getItem('k'), 'local')
  assert.equal(context.sessionStorage.getItem('k'), 'session')
  context.sessionStorage.clear()
  assert.equal(context.localStorage.getItem('k'), 'local')
})

void test('document.cookie keeps name=value pairs in memory', () => {
  const { document } = loadProxy()
  assert.equal(document.cookie, '')
  document.cookie = 'a=1; Path=/'
  assert.equal(document.cookie, 'a=1')
  document.cookie = 'b=2; SameSite=Lax'
  assert.equal(document.cookie, 'a=1; b=2')
  document.cookie = ' a = 3 '
  assert.equal(document.cookie, 'a=3; b=2')
  document.cookie = 'ignored'
  assert.equal(document.cookie, 'a=3; b=2')
  document.cookie = 'a=; Max-Age=0'
  assert.equal(document.cookie, 'b=2')
  document.cookie = 'b=gone; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  assert.equal(document.cookie, '')
})
