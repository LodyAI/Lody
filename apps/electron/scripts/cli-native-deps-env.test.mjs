import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fetchNativeBinaryPackage } from './cli-native-deps.mjs'

function fakeSpawn(calls) {
  return (_command, args, options) => {
    calls.push({ args, options })
    const prefix = args[args.indexOf('--prefix') + 1]
    const packageDir = path.join(prefix, 'node_modules', '@loro-dev', 'roost-node-darwin-arm64')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), '{}')
    return { status: 0 }
  }
}

void test('native binary install disables prefer-offline for its npm child', () => {
  const calls = []
  const result = fetchNativeBinaryPackage(
    '@loro-dev/roost-node-darwin-arm64',
    '0.3.1',
    fakeSpawn(calls),
    {}
  )
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.env.npm_config_prefer_offline, 'false')
  } finally {
    result.cleanup()
  }
})

void test('the inherited environment is preserved except for prefer-offline', () => {
  const calls = []
  const result = fetchNativeBinaryPackage(
    '@loro-dev/roost-node-darwin-arm64',
    '0.3.1',
    fakeSpawn(calls),
    {
      PATH: process.env.PATH,
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_prefer_offline: 'true'
    }
  )
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.env.npm_config_registry, 'https://registry.npmjs.org/')
    assert.equal(calls[0].options.env.npm_config_prefer_offline, 'false')
  } finally {
    result.cleanup()
  }
})
