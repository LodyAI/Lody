import assert from 'node:assert/strict'
import test from 'node:test'
import { sparkleEventToStatePatch } from './app-updater-sparkle-events.ts'

const NOW = 1_700_000_000_000

void test('maps a user-initiated check onto the checking phase and clears progress', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'checking' }, NOW), {
    phase: 'checking',
    error: undefined,
    checkedAtMs: NOW,
    percent: undefined,
    bytesPerSecond: undefined,
    transferred: undefined,
    total: undefined
  })
})

void test('maps an available update onto downloading so the sidebar banner can appear', () => {
  assert.deepEqual(
    sparkleEventToStatePatch(
      {
        type: 'update-available',
        version: '1.2.3',
        releaseName: 'Lody 1.2.3',
        releaseDate: '2026-08-30T00:00:00Z',
        releaseNotes: 'Fixes the updater banner'
      },
      NOW
    ),
    {
      phase: 'downloading',
      availableVersion: '1.2.3',
      downloadedVersion: undefined,
      releaseName: 'Lody 1.2.3',
      releaseDate: '2026-08-30T00:00:00Z',
      releaseNotes: 'Fixes the updater banner',
      releaseNotesByLocale: undefined,
      checkedAtMs: NOW,
      error: undefined
    }
  )
})

void test('maps download progress onto percent and byte counts', () => {
  assert.deepEqual(
    sparkleEventToStatePatch(
      {
        type: 'download-progress',
        percent: 42.6,
        transferred: 426,
        total: 1000
      },
      NOW
    ),
    {
      phase: 'downloading',
      percent: 42.6,
      bytesPerSecond: undefined,
      transferred: 426,
      total: 1000
    }
  )
})

void test('derives percent from transferred/total when Sparkle omits it', () => {
  assert.equal(
    sparkleEventToStatePatch(
      {
        type: 'download-progress',
        transferred: 25,
        total: 50
      },
      NOW
    )?.percent,
    50
  )
})

void test('maps a finished download onto the downloaded phase for Restart', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'update-downloaded', version: '1.2.4' }, NOW), {
    phase: 'downloaded',
    downloadedVersion: '1.2.4',
    availableVersion: '1.2.4',
    checkedAtMs: NOW,
    error: undefined
  })
})

void test('maps no-update onto up_to_date and clears the banner fields', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'update-not-available' }, NOW), {
    phase: 'up_to_date',
    availableVersion: undefined,
    downloadedVersion: undefined,
    percent: undefined,
    bytesPerSecond: undefined,
    transferred: undefined,
    total: undefined,
    checkedAtMs: NOW,
    error: undefined
  })
})

void test('maps a Sparkle failure onto the error phase', () => {
  assert.deepEqual(sparkleEventToStatePatch({ type: 'error', message: 'feed unreachable' }, NOW), {
    phase: 'error',
    error: 'feed unreachable',
    checkedAtMs: NOW
  })
})

void test('ignores unknown or malformed Sparkle events', () => {
  assert.equal(sparkleEventToStatePatch({ type: 'nope' }, NOW), null)
  assert.equal(sparkleEventToStatePatch(null, NOW), null)
  assert.equal(sparkleEventToStatePatch('checking', NOW), null)
  assert.equal(sparkleEventToStatePatch({ type: 'error' }, NOW), null)
})
