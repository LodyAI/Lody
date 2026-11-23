import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadConfigFromFile } from 'electron-vite'
const directory = fileURLToPath(new URL('.', import.meta.url))
async function config(mode = 'oss') {
  return (
    await loadConfigFromFile(
      { command: 'build', mode },
      fileURLToPath(new URL('./electron.vite.config.ts', import.meta.url)),
      directory
    )
  ).config
}
const cloudEnv = {
  VITE_LODY_PLATFORM: 'cloud',
  LODY_ENV: 'production',
  VITE_CONVEX_DEPLOY_URL: 'https://deploy.example.test',
  VITE_CONVEX_SITE_URL: 'https://auth.example.test',
  VITE_SERVER_URL: 'https://server.example.test',
  VITE_SITE_URL: 'https://site.example.test',
  VITE_ELECTRON_UPDATE_URL: 'https://updates.example.test/production',
  VITE_ELECTRON_UPDATE_CHANNEL: 'latest'
}
test('default local discards inherited cloud values and telemetry', async (t) => {
  const old = { ...process.env }
  t.after(() => {
    process.env = old
  })
  Object.assign(process.env, cloudEnv, {
    VITE_PUBLIC_POSTHOG_HOST: 'https://analytics.example.test',
    LODY_LORO_STREAMS_WS_ENABLED: '1',
    VITE_LORO_STREAMS_WS_ENABLED: '1'
  })
  delete process.env.VITE_LODY_PLATFORM
  const built = await config()
  assert.equal(built.main.define['import.meta.env.VITE_LODY_PLATFORM'], '"local"')
  assert.equal(built.renderer.envDir, false)
  assert.equal(built.renderer.define['import.meta.env.VITE_SERVER_URL'], undefined)
  assert.equal(process.env.VITE_PUBLIC_POSTHOG_HOST, undefined)
  assert.equal(built.renderer.define['import.meta.env.VITE_LORO_STREAMS_WS_ENABLED'], undefined)
})
test('explicit cloud fails closed for each missing required endpoint', async (t) => {
  const old = { ...process.env }
  t.after(() => {
    process.env = old
  })
  for (const key of Object.keys(cloudEnv).filter(
    (k) => k.startsWith('VITE_') && k !== 'VITE_LODY_PLATFORM'
  )) {
    Object.assign(process.env, cloudEnv)
    delete process.env[key]
    await assert.rejects(config('production'), new RegExp(key))
  }
})
test('explicit cloud injects audited endpoints, cloud CSP and update identity', async (t) => {
  const old = { ...process.env }
  t.after(() => {
    process.env = old
  })
  Object.assign(process.env, cloudEnv)
  const built = await config('production')
  assert.equal(built.main.define['import.meta.env.VITE_LODY_PLATFORM'], '"cloud"')
  assert.equal(
    built.renderer.define['import.meta.env.VITE_SERVER_URL'],
    JSON.stringify(cloudEnv.VITE_SERVER_URL)
  )
  assert.equal(built.renderer.envDir, false)
  assert.ok(built.renderer.plugins.some((p) => p?.name === 'lody-electron-cloud-renderer-csp'))
  assert.ok(built.main.plugins.some((p) => p?.name === 'lody-electron-update-config-manifest'))
  assert.ok(built.main.build.externalizeDeps.include.includes('better-sqlite3'))
})

test('Cloud gives main and renderer the same Streams WebSocket setting', async (t) => {
  const old = { ...process.env }
  t.after(() => {
    process.env = old
  })
  const key = 'VITE_LORO_STREAMS_WS_ENABLED'
  for (const [flag, legacy, expected] of [
    [undefined, undefined, '0'],
    ['1', undefined, '1'],
    ['true', '0', '1'],
    ['0', '1', '0'],
    [undefined, 'true', '1'],
    ['on', '1', '0']
  ]) {
    Object.assign(process.env, cloudEnv)
    delete process.env.LODY_LORO_STREAMS_WS_ENABLED
    delete process.env[key]
    if (flag !== undefined) process.env.LODY_LORO_STREAMS_WS_ENABLED = flag
    if (legacy !== undefined) process.env[key] = legacy
    const built = await config('production')
    assert.equal(built.main.define[`import.meta.env.${key}`], JSON.stringify(expected))
    assert.equal(built.renderer.define[`import.meta.env.${key}`], JSON.stringify(expected))
  }
})
