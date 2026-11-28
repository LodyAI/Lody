import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SMOKE_PRESERVED_COOKIE_KEY,
  SMOKE_REVOKED_SESSION_TOKEN,
  buildAndroidSharedPrefsXml,
  buildRevokedSessionSeed,
  buildSmokeProbeScript,
  collectRedirectOrigins,
  evaluateAuthRequest,
  injectSmokeProbeHtml,
  parseSmokeCliArgs,
  selectIosSimulatorTarget,
  startSmokeStubServer,
} from './native-startup-smoke-lib.mjs';

test('injectSmokeProbeHtml inserts probe before </head>', () => {
  const html =
    '<!doctype html><html><head><title>Lody</title></head><body><div id="root"></div></body></html>';
  const injected = injectSmokeProbeHtml(html, 'window.__probe=1;');
  assert.ok(
    injected.includes('<script data-lody-smoke-probe="1">window.__probe=1;</script>\n</head>')
  );
});

test('selectIosSimulatorTarget selects newest compatible standard iPhone and iOS runtime', () => {
  const target = selectIosSimulatorTarget({
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        name: 'iOS 26.5',
        version: '26.5',
        isAvailable: true,
        supportedDeviceTypes: [
          { name: 'iPhone 16', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
        ],
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
        name: 'iOS 27.0',
        version: '27.0',
        isAvailable: true,
        supportedDeviceTypes: [
          { name: 'iPhone Duo', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo' },
          { name: 'iPhone 17', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
          {
            name: 'iPhone 17 Pro',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          },
        ],
      },
    ],
  });
  assert.equal(target.runtimeId, 'com.apple.CoreSimulator.SimRuntime.iOS-27-0');
  assert.equal(target.deviceTypeId, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17');
});

test('evaluateAuthRequest validates native capacitor-origin and rejects leaked crossDomain cookie header', () => {
  assert.equal(evaluateAuthRequest({ 'capacitor-origin': 'lody://' }).ok, true);
  assert.equal(evaluateAuthRequest({}).ok, false);
  assert.equal(
    evaluateAuthRequest({ 'capacitor-origin': 'lody://', 'better-auth-cookie': 'stale=1' }).ok,
    false
  );
});

test('startSmokeStubServer resolves on clean native startup and /login convergence', async () => {
  const stub = await startSmokeStubServer({ expectedPlatform: 'ios', timeoutMs: 5_000 });
  try {
    const resultPromise = stub.waitForResult();
    const preflight = await fetch(`${stub.origin}/api/auth/get-session`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'capacitor://localhost',
        'Access-Control-Request-Headers': 'capacitor-origin',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost');

    const authRes = await fetch(`${stub.origin}/api/auth/get-session`, {
      headers: { 'capacitor-origin': 'lody://' },
    });
    assert.equal(authRes.status, 200);
    assert.equal(await authRes.text(), 'null');

    await fetch(`${stub.origin}/__smoke__/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'settled',
        isNative: true,
        platform: 'ios',
        booted: true,
        pathname: '/login',
        interactiveCount: 3,
        bodyText: 'Welcome to Lody AI\nSign in with Google\nContinue with email',
      }),
    });

    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.authRequests.length, 1);
  } finally {
    await stub.close();
  }
});

test('startSmokeStubServer fails fast on Capacitor Preferences.then() unhandled rejection', async () => {
  const stub = await startSmokeStubServer({ expectedPlatform: 'ios', timeoutMs: 5_000 });
  try {
    const resultPromise = stub.waitForResult();
    await fetch(`${stub.origin}/__smoke__/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'unhandledrejection',
        message: 'Error: "Preferences.then()" is not implemented on ios',
      }),
    });
    await assert.rejects(resultPromise, /Preferences\.then\(\)" is not implemented on ios/);
  } finally {
    await stub.close();
  }
});

test('startSmokeStubServer fails fast on BlockingWaitPlaceholder startup timeout screen', async () => {
  const stub = await startSmokeStubServer({ expectedPlatform: 'android', timeoutMs: 5_000 });
  try {
    const resultPromise = stub.waitForResult();
    await fetch(`${stub.origin}/__smoke__/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'snapshot',
        isNative: true,
        platform: 'android',
        booted: true,
        pathname: '/',
        interactiveCount: 2,
        bodyText: 'Lody is taking too long to open\nReload Lody',
      }),
    });
    await assert.rejects(resultPromise, /Lody is taking too long to open/);
  } finally {
    await stub.close();
  }
});

test('startSmokeStubServer fails fast when better-auth-cookie leaks on native auth request', async () => {
  const stub = await startSmokeStubServer({ expectedPlatform: 'ios', timeoutMs: 5_000 });
  try {
    const resultPromise = stub.waitForResult();
    await fetch(`${stub.origin}/api/auth/get-session`, {
      headers: {
        'capacitor-origin': 'lody://',
        'better-auth-cookie': 'leaked=1',
      },
    });
    await assert.rejects(resultPromise, /crossDomainClient leaked/);
  } finally {
    await stub.close();
  }
});

test('collectRedirectOrigins and buildSmokeProbeScript embed configured endpoints', () => {
  const origins = collectRedirectOrigins({
    VITE_CONVEX_SITE_URL: 'https://custom-auth.example.com/path',
    VITE_SERVER_URL: 'https://custom-server.example.com',
  });
  assert.ok(origins.includes('https://custom-auth.example.com'));
  assert.ok(origins.includes('https://custom-server.example.com'));
  const script = buildSmokeProbeScript({
    stubOrigin: 'http://127.0.0.1:43210',
    redirectOrigins: origins,
  });
  assert.ok(script.includes('http://127.0.0.1:43210'));
  assert.ok(script.includes('https://custom-auth.example.com'));
});

test('parseSmokeCliArgs parses flags cleanly', () => {
  const parsed = parseSmokeCliArgs([
    '--',
    '--skip-build',
    '--skip-sync',
    '--udid',
    'ABC-123',
    '--timeout',
    '45000',
    '--artifact-dir',
    '/tmp/out',
  ]);
  assert.equal(parsed.skipBuild, true);
  assert.equal(parsed.skipSync, true);
  assert.equal(parsed.udid, 'ABC-123');
  assert.equal(parsed.timeoutMs, 45_000);
  assert.equal(parsed.artifactDir, '/tmp/out');
});

test('buildRevokedSessionSeed and buildAndroidSharedPrefsXml encode CapacitorStorage entries', () => {
  const seed = buildRevokedSessionSeed();
  const parsed = JSON.parse(seed.cookieValue);
  assert.equal(parsed['__Secure-better-auth.session_token'].value, SMOKE_REVOKED_SESSION_TOKEN);
  assert.equal(parsed[SMOKE_PRESERVED_COOKIE_KEY].value, 'keep-me');
  const xml = buildAndroidSharedPrefsXml({
    [seed.cookieKey]: seed.cookieValue,
    [seed.sessionDataKey]: seed.sessionDataValue,
  });
  assert.ok(xml.includes('name="better-auth_cookie"'));
  assert.ok(xml.includes('&quot;lody-smoke-revoked-session-token&quot;'));
});

test('startSmokeStubServer resetScenario verifies revoked bearer token send and native Preferences cleanup', async () => {
  const stub = await startSmokeStubServer({ expectedPlatform: 'ios', timeoutMs: 5_000 });
  try {
    stub.resetScenario({
      name: 'revoked-session-cleanup',
      expectedBearerToken: SMOKE_REVOKED_SESSION_TOKEN,
      expectClearedToken: SMOKE_REVOKED_SESSION_TOKEN,
      timeoutMs: 5_000,
    });
    const resultPromise = stub.waitForResult();

    await fetch(`${stub.origin}/api/auth/get-session`, {
      headers: {
        'capacitor-origin': 'lody://',
        authorization: `Bearer ${SMOKE_REVOKED_SESSION_TOKEN}`,
      },
    });

    await fetch(`${stub.origin}/__smoke__/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'settled',
        isNative: true,
        platform: 'ios',
        booted: true,
        pathname: '/login',
        interactiveCount: 3,
        bodyText: 'Welcome to Lody AI\nSign in with Google\nContinue with email',
        nativePreferences: {
          cookie: null,
          sessionData: 'null',
        },
      }),
    });

    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.scenario, 'revoked-session-cleanup');
    assert.equal(
      result.diagnostics.authRequests[0].authorization,
      `Bearer ${SMOKE_REVOKED_SESSION_TOKEN}`
    );
  } finally {
    await stub.close();
  }
});
