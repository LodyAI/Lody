import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { persistElectronMainFatalLog } from './electron-main-fatal-log.ts'

void test('persists the uncaught exception stack before Electron exits', () => {
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-electron-main-fatal-'))
  const error = new Error('renderer broadcast failed')
  error.stack = 'Error: renderer broadcast failed\n    at publish (loro-data-plane-relay.ts:366:16)'

  try {
    persistElectronMainFatalLog(logDirectory, {
      error,
      origin: 'uncaughtException',
      version: '0.91.1',
      timestamp: new Date('2026-09-05T06:19:12.000Z')
    })

    const contents = fs.readFileSync(path.join(logDirectory, 'electron-main-fatal.log'), 'utf8')
    assert.match(contents, /2026-09-05T06:19:12\.000Z/)
    assert.match(contents, /version=0\.91\.1 origin=uncaughtException/)
    assert.match(contents, /at publish \(loro-data-plane-relay\.ts:366:16\)/)
  } finally {
    fs.rmSync(logDirectory, { recursive: true, force: true })
  }
})

void test('does not throw when the fatal log cannot be written', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-electron-main-fatal-'))
  const filePath = path.join(parent, 'not-a-directory')
  fs.writeFileSync(filePath, 'occupied')

  try {
    assert.doesNotThrow(() => {
      persistElectronMainFatalLog(filePath, {
        error: new Error('original fatal error'),
        origin: 'uncaughtException',
        version: '0.91.1'
      })
    })
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
