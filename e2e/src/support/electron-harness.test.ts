import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIsolatedEnvironment } from './electron-harness.js';

void describe('Electron harness environment', () => {
  void it('inherits the Xvfb display authorization without leaking unrelated variables', () => {
    const env = createIsolatedEnvironment(
      { NODE_ENV: 'test' },
      {
        DISPLAY: ':99',
        LODY_PRIVATE_VALUE: 'excluded',
        XAUTHORITY: '/tmp/xvfb-auth',
      }
    );

    assert.deepEqual(env, {
      DISPLAY: ':99',
      XAUTHORITY: '/tmp/xvfb-auth',
      NODE_ENV: 'test',
    });
  });
});
