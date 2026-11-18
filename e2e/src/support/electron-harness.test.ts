import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIsolatedEnvironment } from './electron-harness.js';

void describe('Electron harness environment', () => {
  void it('inherits the Xvfb display authorization without leaking unrelated variables', () => {
    const env = createIsolatedEnvironment(
      { NODE_ENV: 'test' },
      {
        DISPLAY: ':99',
        LODY_E2E_SHOW_WINDOW: '1',
        LODY_NATIVE_MACHINE_CATALOG: '1',
        LODY_NATIVE_SCHEDULE_REGISTRY: '1',
        LODY_NATIVE_WORKSPACE_META: '1',
        LODY_PRIVATE_VALUE: 'excluded',
        XAUTHORITY: '/tmp/xvfb-auth',
      }
    );

    assert.deepEqual(env, {
      DISPLAY: ':99',
      LODY_E2E_SHOW_WINDOW: '1',
      LODY_NATIVE_MACHINE_CATALOG: '1',
      LODY_NATIVE_SCHEDULE_REGISTRY: '1',
      LODY_NATIVE_WORKSPACE_META: '1',
      XAUTHORITY: '/tmp/xvfb-auth',
      NODE_ENV: 'test',
    });
  });
});
