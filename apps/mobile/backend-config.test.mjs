import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, resolveBackendConfig } from './backend-config.mjs';

test('unconfigured mobile builds preserve production endpoints and existing credential namespace', () => {
  const production = { ...defaults, STORAGE_SUFFIX: '', LORO_STREAMS_WS_ENABLED: '0' };
  assert.deepEqual(resolveBackendConfig('', {}), production);
  assert.deepEqual(resolveBackendConfig('CONVEX_URL=\nCF_WORKER_URL=""', {}), production);
});

test('mobile local builds select both Convex interfaces and Worker without sharing production storage', () => {
  const text =
    'CONVEX_URL=https://rpc.test\nCONVEX_SITE_URL="https://auth.test/"\nCF_WORKER_URL=https://worker.test';
  const config = resolveBackendConfig(text, {});
  assert.equal(config.CONVEX_URL, 'https://rpc.test');
  assert.equal(config.CONVEX_SITE_URL, 'https://auth.test');
  assert.equal(config.CF_WORKER_URL, 'https://worker.test');
  assert.match(config.STORAGE_SUFFIX, /^-[a-f0-9]{24}$/);
  assert.equal(resolveBackendConfig(text, {}).STORAGE_SUFFIX, config.STORAGE_SUFFIX);
  const overridden = resolveBackendConfig(text, { CF_WORKER_URL: 'https://other.test' });
  assert.equal(overridden.CF_WORKER_URL, 'https://other.test');
  assert.notEqual(overridden.STORAGE_SUFFIX, config.STORAGE_SUFFIX);
});

test('invalid configured endpoints fail the build instead of silently sending credentials to production', () => {
  for (const value of [
    'http://localhost:3211',
    'https://user:secret@host.test',
    'https://host.test/path',
    'https://host.test?key=x',
    'https://host.test#x',
    'https://host.test?',
    'https://host.test#',
    'https://@host.test',
    'https:host.test',
    'https://host.test/a/..',
    'https://host.test:0',
    '$(command)',
    'bad',
  ]) {
    assert.throws(
      () => resolveBackendConfig('', { CONVEX_SITE_URL: value }),
      /Invalid CONVEX_SITE_URL/
    );
  }
});

test('changing any backend isolates native credentials and persisted account data', () => {
  const namespaces = Object.keys(defaults).map(
    (key) => resolveBackendConfig('', { [key]: 'https://local.test' }).STORAGE_SUFFIX
  );
  assert.equal(new Set(namespaces).size, 3);
  assert.ok(namespaces.every((value) => value !== ''));
});

test('the Streams WebSocket switch follows desktop rules and never moves stored data', () => {
  for (const value of ['1', 'true'])
    assert.equal(
      resolveBackendConfig('', { LODY_LORO_STREAMS_WS_ENABLED: value }).LORO_STREAMS_WS_ENABLED,
      '1'
    );
  for (const value of ['0', 'false', 'yes', 'TRUE', ' 1', ''])
    assert.equal(
      resolveBackendConfig('', { LODY_LORO_STREAMS_WS_ENABLED: value }).LORO_STREAMS_WS_ENABLED,
      '0'
    );
  assert.equal(
    resolveBackendConfig('LODY_LORO_STREAMS_WS_ENABLED=1', {}).LORO_STREAMS_WS_ENABLED,
    '1'
  );
  assert.equal(
    resolveBackendConfig('LODY_LORO_STREAMS_WS_ENABLED=1', { LODY_LORO_STREAMS_WS_ENABLED: '0' })
      .LORO_STREAMS_WS_ENABLED,
    '0'
  );
  const enabled = resolveBackendConfig('', { LODY_LORO_STREAMS_WS_ENABLED: '1' });
  assert.equal(enabled.STORAGE_SUFFIX, '');
  const local = { CF_WORKER_URL: 'https://local.test' };
  assert.equal(
    resolveBackendConfig('', { ...local, LODY_LORO_STREAMS_WS_ENABLED: '1' }).STORAGE_SUFFIX,
    resolveBackendConfig('', local).STORAGE_SUFFIX
  );
});
