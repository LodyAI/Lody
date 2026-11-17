import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, resolveBackendConfig } from './backend-config.mjs';

test('unconfigured mobile builds preserve production endpoints and existing credential namespace', () => {
  assert.deepEqual(resolveBackendConfig('', {}), { ...defaults, STORAGE_SUFFIX: '' });
  assert.deepEqual(resolveBackendConfig('CONVEX_URL=\nCF_WORKER_URL=""', {}), {
    ...defaults,
    STORAGE_SUFFIX: '',
  });
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
