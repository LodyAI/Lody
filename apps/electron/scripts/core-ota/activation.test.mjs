import { CoreUpdaterService } from '../../src/main/services/core-updater-service.ts'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { openInstalledCore } from './bootstrap.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { signManifest, sha256 } from './protocol.mjs'
import { openActivation } from './activation.mjs'

test('restart rejects interrupted release; healthy release survives and corruption falls back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'activation-'))
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const installed = {
      product: 'lody',
      channel: 'nightly',
      platform: 'darwin',
      arch: 'arm64',
      hostAbi: 'abi1'
    }
    const options = { root, installed, publicKey, lease: { assertHeld() {} } }
    await assert.rejects(openInstalledCore({ resourcesPath: root, root, isOwner: () => false }))
    await assert.rejects(
      openActivation({
        ...options,
        lease: {
          assertHeld() {
            throw new Error('not owner')
          }
        }
      }),
      /not owner/
    )
    const owner = await openActivation(options)
    async function stage(id, seq) {
      const directory = path.join(owner.directory, 'releases', id)
      await mkdir(directory, { recursive: true })
      const bytes = Buffer.from('export default 1')
      const hash = sha256(bytes)
      const manifest = signManifest(
        {
          schemaVersion: 1,
          releaseId: id,
          seq,
          channel: installed.channel,
          platform: installed.platform,
          arch: installed.arch,
          hostAbi: installed.hostAbi,
          tree: [{ path: 'core.mjs', sha256: hash, size: bytes.length }],
          packs: [{ path: 'pack', sha256: hash, size: bytes.length }],
          objects: {
            [hash]: { packSha256: hash, offset: 0, length: bytes.length, compressedSha256: hash }
          },
          patches: []
        },
        privateKey
      )
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(path.join(directory, 'core.mjs'), bytes)
      return directory
    }
    await stage('one', 1)
    await owner.stage('one')
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { openActivation } from ${JSON.stringify(new URL('./activation.mjs', import.meta.url).href)};
      const activation = await openActivation({root:process.argv[1],installed:JSON.parse(process.argv[2]),publicKey:process.argv[3],lease:{assertHeld(){}}});
      await activation.begin();
    `,
        root,
        JSON.stringify(installed),
        publicKey.export({ type: 'spki', format: 'pem' })
      ],
      { encoding: 'utf8' }
    )
    assert.equal(child.status, 0, child.stderr)
    const restarted = await openActivation(options)
    assert.equal((await restarted.begin()).builtin, true)
    await assert.rejects(restarted.stage('one'))
    const directory = await stage('two', 2)
    await restarted.stage('two')
    const selection = await restarted.begin()
    await assert.rejects(restarted.acknowledge({ ...selection, attemptId: 'wrong' }))
    await assert.rejects(restarted.abandon({ ...selection, attemptId: 'wrong' }))
    const quittingService = new CoreUpdaterService({}, restarted)
    quittingService.selection = selection
    await quittingService.abandonHealthAttempt()
    const gracefulRestart = await openActivation(options)
    const retrySelection = await gracefulRestart.begin()
    assert.equal(retrySelection.releaseId, selection.releaseId)
    assert.notEqual(retrySelection.attemptId, selection.attemptId)
    await gracefulRestart.acknowledge(retrySelection)
    const healthy = await openActivation(options)
    const healthySelection = await healthy.begin()
    assert.equal(healthySelection.releaseId, 'two')
    await healthy.acknowledge(healthySelection)
    await writeFile(path.join(directory, 'core.mjs'), 'corrupted')
    const corrupt = await openActivation(options)
    assert.equal((await corrupt.begin()).builtin, true)
    const source = await stage('three', 3)
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
    const downloadDirectory = path.join(root, 'hash-download')
    await mkdir(downloadDirectory)
    await writeFile(path.join(downloadDirectory, 'core.mjs'), Buffer.from('export default 1'))
    await rm(source, { recursive: true })
    await corrupt.adoptStaged({ directory: downloadDirectory, manifest })
    const stagedState = JSON.parse(
      await readFile(path.join(owner.directory, 'pointer.json'), 'utf8')
    )
    assert.equal(stagedState.current, null)
    assert.equal(stagedState.staged, 'three')
    const nextLaunch = await openActivation(options)
    const failedSelection = await nextLaunch.begin()
    assert.equal(failedSelection.releaseId, 'three')
    const failedService = new CoreUpdaterService({}, nextLaunch)
    failedService.selection = failedSelection
    failedService.setHealthRescue(async () => {
      const persisted = JSON.parse(
        await readFile(path.join(owner.directory, 'pointer.json'), 'utf8')
      )
      assert.ok(persisted.rejected.includes('three'))
      assert.equal(persisted.attempt, null)
      throw new Error('quit rejected')
    })
    await assert.rejects(failedService.failInitialHealth(), /quit rejected/)
    const failureState = JSON.parse(
      await readFile(path.join(owner.directory, 'pointer.json'), 'utf8')
    )
    assert.ok(failureState.rejected.includes('three'))
    assert.equal(failureState.attempt, null)
    const recovered = await openActivation(options)
    assert.equal((await recovered.begin()).builtin, true)
    await chmod(path.join(owner.directory, 'releases', 'three'), 0o700)
    await writeFile(
      path.join(owner.directory, 'pointer.json'),
      JSON.stringify({ current: '../../escape' })
    )
    await assert.rejects(openActivation(options), /Invalid Core activation pointer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
