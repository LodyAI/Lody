import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { electron } from '@better-auth/electron'
import { crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { createDesktopAuthFetch } from '../../main/auth-fetch.ts'
import {
  DesktopLogin,
  DesktopLoginFailure,
  readDesktopLoginCallback
} from '../../main/services/desktop-login.ts'

const session = { session: { token: 'synthetic-session' }, user: { id: 'synthetic-user' } }

void test('desktop auth waits for app readiness and preserves the cookie plugin round trip', async () => {
  const ready = deferred()
  const waitingForReady = deferred()
  let appReady = false
  const storage = new Map()
  const cookie = 'better-auth.session_token=synthetic-session'
  const client = createAuthClient({
    baseURL: 'https://auth.example.test',
    plugins: [
      crossDomainClient({
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value)
        }
      })
    ],
    fetchOptions: {
      customFetchImpl: createDesktopAuthFetch({
        whenReady: () => {
          waitingForReady.resolve()
          return ready.promise
        },
        fetch: async (input, init) => {
          assert.equal(appReady, true)
          const request = new Request(input, init)
          assert.equal(request.credentials, 'omit')
          if (new URL(request.url).pathname.endsWith('/electron/token')) {
            assert.equal(request.method, 'POST')
            assert.deepEqual(await request.json(), { token: 'synthetic-code' })
            return Response.json(session, {
              headers: { 'set-better-auth-cookie': `${cookie}; Path=/; HttpOnly; Max-Age=3600` }
            })
          }
          // The next authenticated read must use the cookie saved by Better Auth.
          return Response.json(
            request.headers.get('Better-Auth-Cookie')?.includes(cookie) ? session : null
          )
        }
      })
    }
  })
  const pending = client.$fetch('/electron/token', {
    method: 'POST',
    body: { token: 'synthetic-code' },
    throw: true
  })
  await waitingForReady.promise
  assert.equal(storage.size, 0)
  appReady = true
  ready.resolve('ready')
  assert.deepEqual(await pending, session)
  assert.ok(client.getCookie().includes(cookie))
  const restored = await client.getSession({ query: { disableCookieCache: true } })
  assert.deepEqual(restored.data, session)
})

void test('desktop auth accepts URL and Request inputs without consuming bodies or response headers', async () => {
  const fetch = createDesktopAuthFetch({
    whenReady: async () => {},
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const headers = new Headers()
      headers.append('set-cookie', 'first=synthetic; Path=/')
      headers.append('set-cookie', 'second=synthetic; Path=/')
      return Response.json({ url: request.url, body: await request.text() }, { headers })
    }
  })
  const url = new URL('https://auth.example.test/api/auth/electron/token')
  assert.deepEqual(await (await fetch(url)).json(), { url: url.href, body: '' })
  const response = await fetch(new Request(url, { method: 'POST', body: 'synthetic-body' }))
  assert.deepEqual(response.headers.getSetCookie(), [
    'first=synthetic; Path=/',
    'second=synthetic; Path=/'
  ])
  assert.deepEqual(await response.json(), { url: url.href, body: 'synthetic-body' })
  const controller = new AbortController()
  controller.abort()
  const abortedRequest = new Request(url, { signal: controller.signal })
  await assert.rejects(fetch(abortedRequest), { name: 'AbortError' })
  // A fetch init can explicitly replace a Request's aborted signal with null.
  assert.deepEqual(await (await fetch(abortedRequest, { signal: null })).json(), {
    url: url.href,
    body: ''
  })
})

void test('desktop auth cannot send a request cancelled while app readiness is pending', async () => {
  const ready = deferred()
  const controller = new AbortController()
  const fetch = createDesktopAuthFetch({
    whenReady: () => ready.promise,
    fetch: async () => Response.json(session)
  })
  const pending = fetch('https://auth.example.test', { signal: controller.signal })
  controller.abort()
  ready.resolve()
  await assert.rejects(pending, { name: 'AbortError' })
})

void test('Nightly login selects its callback channel and rejects callbacks addressed to Stable', async (t) => {
  const { login, browser, callback } = harness(t, { channel: 'nightly' })
  await login.start()
  assert.equal(browser[0].client_id, 'electron')
  assert.equal(browser[0].desktop_channel, 'nightly')
  const token = callback()
  assert.equal(
    readDesktopLoginCallback(`lody://auth/callback#token=${token}`, 'ai.lody.nightly'),
    null
  )
  assert.equal(readDesktopLoginCallback(`ai.lody.nightly://auth/callback#token=${token}`), null)
  const accepted = readDesktopLoginCallback(
    `ai.lody.nightly://auth/callback#token=${token}`,
    'ai.lody.nightly'
  )
  assert.equal(accepted, token)
  await login.complete(accepted)
  assert.equal(login.getState().phase, 'authenticated')
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function harness(t, overrides = {}) {
  const browser = []
  const snapshots = []
  const login = new DesktopLogin({
    openBrowser: async (query) => {
      browser.push(query)
    },
    exchange: async (body) => {
      assert.equal(
        createHash('sha256').update(body.code_verifier).digest('base64url'),
        browser.at(-1).code_challenge
      )
      assert.equal(body.state, browser.at(-1).state)
      return session
    },
    publish: (state) => snapshots.push(state),
    authenticated: () => {},
    ...overrides
  })
  t.after(() => login.cancel())
  const callback = (query = browser.at(-1)) =>
    Buffer.from(JSON.stringify({ identifier: 'synthetic-code', state: query.state })).toString(
      'base64url'
    )
  return { login, browser, snapshots, callback }
}

void test('main completes PKCE without a renderer or any organization request', async (t) => {
  const { login, callback, snapshots } = harness(t)
  await login.start()
  await login.complete(callback())
  assert.deepEqual(login.getState().session, session)
  assert.equal(login.getState().phase, 'authenticated')
  assert.deepEqual(
    snapshots.map((s) => s.phase),
    ['waiting', 'exchanging', 'authenticated']
  )
  assert.equal(login.getState(), snapshots.at(-1))
})

for (const channel of ['stable', 'nightly']) {
  void test(`the pinned Better Auth endpoint accepts ${channel} PKCE and returns a usable desktop session`, async (t) => {
    const server = betterAuth({
      baseURL: 'https://auth.example.test',
      secret: 'synthetic-test-secret-not-a-real-secret-123456789',
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      plugins: [electron()]
    })
    const signup = await server.api.signUpEmail({
      body: {
        email: 'synthetic@example.test',
        password: 'synthetic-password-123',
        name: 'Synthetic'
      },
      returnHeaders: true
    })
    const headers = new Headers({
      cookie: signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
    })
    const { login, browser } = harness(t, {
      channel,
      exchange: async (body) => {
        const result = await server.api.electronToken({ body })
        return { session: { token: result.token }, user: result.user }
      }
    })
    await login.start()
    const transferred = await server.api.electronTransferUser({
      body: {},
      query: browser[0],
      headers
    })
    const token = Buffer.from(
      JSON.stringify({
        identifier: transferred.electron_authorization_code,
        state: browser[0].state
      })
    ).toString('base64url')
    await login.complete(token)
    assert.equal(login.getState().phase, 'authenticated')
    assert.equal(login.getState().session.user.id, signup.response.user.id)
    assert.ok(login.getState().session.session.token)
    await login.complete(token)
    assert.equal(login.getState().phase, 'authenticated')
  })
}

void test('duplicate callbacks during and after completion keep the established identity', async (t) => {
  const gate = deferred()
  let consumed = false
  const { login, callback } = harness(t, {
    exchange: async () => {
      if (consumed) throw new Error('one-time code was redeemed twice')
      consumed = true
      return await gate.promise
    }
  })
  await login.start()
  const token = callback()
  const first = login.complete(token)
  const second = login.complete(token)
  gate.resolve(session)
  await Promise.all([first, second])
  const committed = login.getState()
  await login.complete(token)
  assert.equal(login.getState(), committed)
  assert.equal(committed.phase, 'authenticated')
})

void test('an older browser tab cannot replace a newer attempt or its completed session', async (t) => {
  const { login, browser, callback } = harness(t)
  await login.start()
  const old = callback()
  await login.start()
  assert.notEqual(browser[0].state, browser[1].state)
  const waiting = login.getState()
  await login.complete(old)
  assert.equal(login.getState(), waiting)
  await login.complete(callback())
  const committed = login.getState()
  await login.complete(old)
  assert.equal(login.getState(), committed)
})

void test('sign-out invalidates late exchange success without resurrecting identity', async (t) => {
  const gate = deferred()
  const { login, callback } = harness(t, { exchange: async () => gate.promise })
  await login.start()
  const completion = login.complete(callback())
  login.cancel()
  gate.resolve(session)
  await completion
  assert.equal(login.getState().phase, 'idle')
  assert.equal(login.getState().session, null)
})

void test('exchange timeout is visible, never reuses its code, and ignores late success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const { login, callback } = harness(t, { exchange: async () => gate.promise })
  await login.start()
  const token = callback()
  const completion = login.complete(token)
  t.mock.timers.tick(25_000)
  await completion
  assert.equal(login.getState().error, 'exchange_timeout')
  await login.complete(token)
  assert.equal(login.getState().phase, 'error')
  gate.resolve(session)
  await gate.promise
  assert.equal(login.getState().session, null)
})

void test('the exchange deadline aborts the desktop auth transport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = deferred()
  const stopped = deferred()
  const fetch = createDesktopAuthFetch({
    whenReady: async () => {},
    fetch: async (_input, init) => {
      started.resolve()
      init.signal.addEventListener('abort', () => stopped.reject(init.signal.reason), {
        once: true
      })
      return stopped.promise
    }
  })
  const { login, callback } = harness(t, {
    exchange: async (_body, signal) => {
      const response = await fetch('https://auth.example.test', { method: 'POST', signal })
      return response.json()
    }
  })
  await login.start()
  const completion = login.complete(callback())
  await started.promise
  t.mock.timers.tick(25_000)
  await completion
  await assert.rejects(stopped.promise, { name: 'AbortError' })
  assert.equal(login.getState().error, 'exchange_timeout')
  assert.equal(login.getState().session, null)
})

void test('an old exchange failure cannot overwrite a new attempt after cancellation', async (t) => {
  const gate = deferred()
  const { login, callback } = harness(t, { exchange: async () => gate.promise })
  await login.start()
  const completion = login.complete(callback())
  login.cancel()
  await login.start()
  const waiting = login.getState()
  gate.reject(new Error('old transport failed'))
  await completion
  assert.equal(login.getState(), waiting)
})

void test('browser launch errors and expired waiting attempts settle with actionable errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failed = harness(t, {
    openBrowser: async () => {
      throw new Error('OS refused')
    }
  })
  await failed.login.start()
  assert.equal(failed.login.getState().error, 'browser_open_failed')
  const { login, callback } = harness(t)
  await login.start()
  t.mock.timers.tick(300_000)
  await login.complete(callback())
  assert.equal(login.getState().error, 'authorization_expired')
  assert.equal(login.getState().session, null)
})

void test('exchange failures carry a credential-free, actionable detail', async (t) => {
  const server = betterAuth({
    baseURL: 'https://auth.example.test',
    secret: 'synthetic-test-secret-not-a-real-secret-123456789',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    plugins: [electron()]
  })
  const client = createAuthClient({
    baseURL: 'https://auth.example.test',
    fetchOptions: { customFetchImpl: (input, init) => server.handler(new Request(input, init)) }
  })
  const reports = []
  const rejected = harness(t, {
    exchange: async (body, signal) =>
      await client.$fetch('/electron/token', { method: 'POST', body, signal, throw: true }),
    reportFailure: (report) => reports.push(report)
  })
  await rejected.login.start()
  // An unknown/expired one-time code, as a real Better Auth 1.5.5 server rejects it.
  await rejected.login.complete(rejected.callback())
  const state = rejected.login.getState()
  assert.equal(state.error, 'exchange_rejected')
  assert.match(state.errorDetail, /^HTTP 4\d\d INVALID_TOKEN /)
  assert.equal(reports.length, 1)
  assert.deepEqual(
    { error: reports[0].error, phase: reports[0].phase, detail: reports[0].detail },
    { error: 'exchange_rejected', phase: 'exchanging', detail: state.errorDetail }
  )
  for (const secret of ['synthetic-code', rejected.browser[0].state]) {
    assert.ok(!state.errorDetail.includes(secret))
  }

  const offline = harness(t, {
    exchange: async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    }
  })
  await offline.login.start()
  await offline.login.complete(offline.callback())
  assert.equal(offline.login.getState().error, 'exchange_failed')
  assert.equal(offline.login.getState().errorDetail, 'TypeError: fetch failed ENOTFOUND')

  // A fresh attempt clears the previous failure's detail.
  await offline.login.start()
  assert.equal(offline.login.getState().errorDetail, null)
})

for (const error of [
  ...[
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED'
  ].map((code) => new TypeError('fetch failed', { cause: { code: 'EFAIL', cause: { code } } })),
  ...['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID'].map(
    (code) => new Error(`net::${code}`)
  )
]) {
  void test(`certificate exchange failure gives network guidance: ${error.cause?.cause?.code ?? error.message}`, async (t) => {
    const reports = []
    const { login, callback } = harness(t, {
      exchange: async () => {
        throw error
      },
      reportFailure: (report) => reports.push(report)
    })
    await login.start()
    const token = callback()
    await login.complete(token)
    const failed = login.getState()
    assert.equal(failed.error, 'exchange_certificate_failed')
    assert.equal(failed.session, null)
    assert.equal(reports[0].error, failed.error)
    assert.equal(reports[0].detail, failed.errorDetail)
    assert.ok(!failed.errorDetail.includes('synthetic-code'))
    await login.complete(token)
    assert.equal(login.getState(), failed)
    await login.start()
    assert.equal(login.getState().error, null)
    assert.equal(login.getState().errorDetail, null)
  })
}

void test('browser launch certificate errors retain the browser failure action', async (t) => {
  const { login } = harness(t, {
    openBrowser: async () => {
      throw new Error('net::ERR_CERT_AUTHORITY_INVALID')
    }
  })
  await login.start()
  assert.equal(login.getState().error, 'browser_open_failed')
})

void test('unavailable secure storage fails before the browser round trip', async (t) => {
  const { login, browser } = harness(t, {
    openBrowser: async () => {
      throw new DesktopLoginFailure('secure_storage_unavailable', 'keychain locked')
    }
  })
  await login.start()
  assert.equal(browser.length, 0)
  assert.equal(login.getState().error, 'secure_storage_unavailable')
  assert.equal(login.getState().errorDetail, 'keychain locked')
})

void test('failure preserves an already authenticated session', async (t) => {
  let fail = false
  const { login, callback } = harness(t, {
    exchange: async () => {
      if (fail) throw new Error('unavailable')
      return session
    }
  })
  await login.start()
  await login.complete(callback())
  fail = true
  await login.start()
  await login.complete(callback())
  assert.equal(login.getState().error, 'exchange_failed')
  assert.equal(login.getState().session, session)
})

void test('a callback after process restart asks for a fresh login and validates its shape', async (t) => {
  const { login } = harness(t)
  await login.complete('malformed')
  assert.equal(login.getState().phase, 'idle')
  await login.complete(
    Buffer.from(JSON.stringify({ identifier: 'code', state: 'old-process' })).toString('base64url')
  )
  assert.equal(login.getState().error, 'restart_required')
  assert.equal(readDesktopLoginCallback('lody://auth/callback#token=abc'), 'abc')
  assert.equal(readDesktopLoginCallback('https://auth/callback#token=abc'), null)
  assert.equal(readDesktopLoginCallback('lody://other/callback#token=abc'), null)
  assert.equal(readDesktopLoginCallback('lody://auth/callback?unexpected=1#token=abc'), null)
})
