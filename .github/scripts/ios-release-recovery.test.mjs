import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIosRecovery } from './ios-release-recovery.mjs';

function fixture() {
  const record = (version, upload = false) => ({
    attributes: {
      platform: 'IOS',
      [upload ? 'cfBundleShortVersionString' : 'version']: version,
    },
  });
  const state = {
    apps: [{ id: '123', attributes: { bundleId: 'ai.lody.mobile' } }],
    versions: [],
    uploads: [],
    next: null,
    second: [],
    calls: [],
    status: 200,
  };
  const args = {
    version: '0.94.0',
    token: 'test-token',
    fetchImpl: async (url, options) => {
      state.calls.push(url.href);
      assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      const versions = url.pathname.endsWith('/preReleaseVersions');
      return {
        ok: state.status === 200,
        status: state.status,
        json: async () => ({
          data: url.searchParams.has('cursor')
            ? state.second
            : url.pathname === '/v1/apps'
              ? state.apps
              : versions
                ? state.versions
                : state.uploads,
          links: { next: versions && !url.searchParams.has('cursor') ? state.next : null },
        }),
      };
    },
  };
  return { state, args, record };
}

await test('admits first build only when target version and upload queries are empty', async () => {
  const { state, args } = fixture();
  assert.deepEqual(await validateIosRecovery(args), {
    appId: '123',
    version: '0.94.0',
    buildNumber: '1',
  });
  assert.equal(state.calls.length, 3);
});
for (const version of ['0.94.0', undefined]) {
  for (const field of ['versions', 'uploads']) {
    await test(`rejects ${field} at ${version} including incomplete uploads`, async () => {
      const { state, args, record } = fixture();
      state[field] = [record(version, field === 'uploads')];
      await assert.rejects(validateIosRecovery(args));
    });
  }
}
await test('follows pages and rejects a target found after the first page', async () => {
  const { state, args, record } = fixture();
  state.next = 'https://api.appstoreconnect.apple.com/v1/apps/123/preReleaseVersions?cursor=2';
  state.second = [record('0.94.0')];
  await assert.rejects(validateIosRecovery(args), /already exists/);
});
await test('never sends credentials to an untrusted pagination origin', async () => {
  const { state, args } = fixture();
  state.next = 'https://attacker.invalid/v1/apps';
  await assert.rejects(validateIosRecovery(args), /Unsafe/);
  assert.equal(state.calls.length, 2);
});
for (const status of [401, 403, 404, 429, 500]) {
  await test(`fails closed on HTTP ${status}`, async () => {
    const { state, args } = fixture();
    state.status = status;
    await assert.rejects(validateIosRecovery(args), /admission read failed/);
  });
}
await test('rejects an ambiguous application', async () => {
  const { state, args } = fixture();
  state.apps.push(state.apps[0]);
  await assert.rejects(validateIosRecovery(args), /Ambiguous/);
});
await test('rejects unknown platforms rather than ignoring malformed records', async () => {
  const { state, args } = fixture();
  state.uploads = [{ attributes: {} }];
  await assert.rejects(validateIosRecovery(args), /already exists/);
});
await test('rejects malformed pagination response', async () => {
  const { args } = fixture();
  args.fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) });
  await assert.rejects(validateIosRecovery(args), /Malformed/);
});

await test('queries only 0.94.0 so unrelated TestFlight 1.0 cannot block recovery', async () => {
  const { args, record } = fixture();
  const paths = [];
  args.fetchImpl = async (url) => {
    paths.push(url.pathname);
    if (url.pathname === '/v1/apps')
      return {
        ok: true,
        json: async () => ({
          data: [{ id: '123', attributes: { bundleId: 'ai.lody.mobile' } }],
          links: {},
        }),
      };
    const isVersion = url.pathname === '/v1/preReleaseVersions';
    assert.equal(url.searchParams.get('filter[platform]'), 'IOS');
    if (isVersion) assert.equal(url.searchParams.get('filter[app]'), '123');
    const filter = url.searchParams.get(
      isVersion ? 'filter[version]' : 'filter[cfBundleShortVersionString]'
    );
    assert.equal(filter, '0.94.0');
    const history = [record('1.0', !isVersion), record('0.93.3', !isVersion)];
    return {
      ok: true,
      json: async () => ({
        data: history.filter(
          (x) => x.attributes[isVersion ? 'version' : 'cfBundleShortVersionString'] === filter
        ),
        links: {},
      }),
    };
  };
  assert.equal((await validateIosRecovery(args)).buildNumber, '1');
  assert.deepEqual(paths, ['/v1/apps', '/v1/preReleaseVersions', '/v1/apps/123/buildUploads']);
});
