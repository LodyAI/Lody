#!/usr/bin/env node
// Isolated Electron main entry, never the product application or its auth store.
const { app } = require('electron')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const directory = mkdtempSync(join(tmpdir(), 'lody-e2ee-ipc-benchmark-'))
app.setPath('userData', directory)
app.setPath('sessionData', join(directory, 'session'))
process.env.LODY_E2EE_BENCHMARK_DIRECTORY = directory
const watchdog = setTimeout(() => {
  process.stderr.write('e2ee_ipc_benchmark_watchdog\n')
  app.exit(1)
}, 90_000)
app.once('will-quit', () => clearTimeout(watchdog))
void import('tsx/esm/api')
  .then(async ({ register }) => {
    register()
    await import('./e2ee-ipc-benchmark-main.mts')
  })
  .catch(() => {
    process.stderr.write('e2ee_ipc_benchmark_bootstrap_failed\n')
    app.exit(1)
  })
