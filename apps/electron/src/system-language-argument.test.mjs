import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readPreferredSystemLanguagesArgument,
  serializePreferredSystemLanguagesArgument
} from './system-language-argument.ts'

void test('round-trips preferred system languages without depending on Chromium locale packs', () => {
  const argument = serializePreferredSystemLanguagesArgument(['zh-Hans-CN', 'en-US'])

  assert.deepEqual(readPreferredSystemLanguagesArgument(['electron', argument]), [
    'zh-Hans-CN',
    'en-US'
  ])
})

void test('rejects a missing or malformed preferred-system-languages argument', () => {
  assert.deepEqual(readPreferredSystemLanguagesArgument(['electron']), [])
  assert.deepEqual(
    readPreferredSystemLanguagesArgument([
      'electron',
      '--lody-preferred-system-languages=%7Bnot-json'
    ]),
    []
  )
})

void test('sanitizes values crossing the main-to-preload bootstrap boundary', () => {
  const encoded = encodeURIComponent(JSON.stringify([' zh_CN ', 42, '', 'en-US']))

  assert.deepEqual(
    readPreferredSystemLanguagesArgument([
      'electron',
      `--lody-preferred-system-languages=${encoded}`
    ]),
    ['zh_CN', 'en-US']
  )
})
