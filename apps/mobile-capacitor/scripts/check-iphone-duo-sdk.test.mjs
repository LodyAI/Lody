import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIPhoneDuoSdk } from './check-iphone-duo-sdk.mjs';

void test('Duo builds require the full-display SDK, not just dynamic resizing support', () => {
  for (const version of ['26.6', '27.0', '27.0.1', '', 'unknown', '27.1beta']) {
    assert.throws(() => assertIPhoneDuoSdk(version), /requires iOS SDK 27.1/);
  }
  for (const version of ['27.1', '27.1.1', '27.2', '28.0', '27.1\n']) {
    assert.doesNotThrow(() => assertIPhoneDuoSdk(version));
  }
});
