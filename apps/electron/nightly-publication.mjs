import assert from 'node:assert/strict'
import { validateNightlyCandidate, validateStoredNightlyCandidate } from './nightly-candidate.mjs'

export const NIGHTLY_METADATA_KEYS = [
  'nightly.yml',
  'nightly-mac.yml',
  'nightly-linux.yml',
  'nightly-linux-arm64.yml',
  'arm64/appcast.xml',
  'x64/appcast.xml',
  'version.json'
]
export const NIGHTLY_JOURNAL_KEY = '_nightly-transaction.json'
const MAX_METADATA_BYTES = 5 * 1024 * 1024

function equalBytes(left, right) {
  return left === null ? right === null : right !== null && left.equals(right)
}

function encode(bytes) {
  if (bytes === null) return null
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_METADATA_BYTES) {
    throw new Error('Invalid or excessive Nightly metadata')
  }
  return bytes.toString('base64')
}

function decode(value) {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('Invalid journal metadata encoding')
  const bytes = Buffer.from(value, 'base64')
  if (encode(bytes) !== value) throw new Error('Non-canonical journal metadata encoding')
  return bytes
}

function readJournal(bytes) {
  const journal = JSON.parse(bytes.toString('utf8'))
  if (journal.schema !== 1) throw new Error('Unsupported Nightly transaction journal')
  validateStoredNightlyCandidate(journal.candidate)
  const keys = Object.keys(journal.entries).sort()
  const expectedKeys = NIGHTLY_METADATA_KEYS.filter(
    (key) => key !== 'nightly-linux-arm64.yml' || keys.includes(key)
  )
  assert.deepEqual(keys, expectedKeys.sort())
  for (const key of keys) {
    const entry = journal.entries[key]
    decode(entry.before)
    if (decode(entry.after) === null) throw new Error('New release metadata must exist')
  }
  assert.deepEqual(
    JSON.parse(decode(journal.entries['version.json'].after)).candidate,
    journal.candidate
  )
  return journal
}

async function verifyWrite(store, key, bytes) {
  if (bytes === null) await store.remove(key)
  else await store.put(key, bytes)
  if (!equalBytes(await store.get(key), bytes)) throw new Error(`Metadata readback failed: ${key}`)
}

/** The workflow holds the common Nightly publication lock across recovery, build and commit. */
export async function recoverNightlyMetadata(store) {
  const bytes = await store.get(NIGHTLY_JOURNAL_KEY)
  if (bytes === null) return { state: 'clean' }
  const journal = readJournal(bytes)
  const keys = NIGHTLY_METADATA_KEYS.filter((key) => Object.hasOwn(journal.entries, key))
  const current = new Map()
  for (const key of keys) {
    const value = await store.get(key)
    const entry = journal.entries[key]
    if (!equalBytes(value, decode(entry.before)) && !equalBytes(value, decode(entry.after))) {
      throw new Error(`Nightly metadata changed outside the pending transaction: ${key}`)
    }
    current.set(key, value)
  }
  const committed = keys.every((key) =>
    equalBytes(current.get(key), decode(journal.entries[key].after))
  )
  if (!committed) {
    for (const key of keys) {
      const before = decode(journal.entries[key].before)
      if (!equalBytes(current.get(key), before)) await verifyWrite(store, key, before)
    }
  }
  await verifyWrite(store, NIGHTLY_JOURNAL_KEY, null)
  return { state: committed ? 'committed' : 'rolled-back', candidate: journal.candidate }
}

/** Immutable assets must already have been uploaded and verified before this call. */
export async function commitNightlyMetadata({ store, candidate, metadata }) {
  validateNightlyCandidate(candidate)
  assert.deepEqual(Object.keys(metadata).sort(), [...NIGHTLY_METADATA_KEYS].sort())
  for (const value of Object.values(metadata)) {
    if (encode(value) === null) throw new Error('Missing new release metadata')
  }
  assert.deepEqual(JSON.parse(metadata['version.json']).candidate, candidate)
  if ((await store.get(NIGHTLY_JOURNAL_KEY)) !== null) {
    throw new Error('Recover the pending Nightly transaction before publishing')
  }
  const entries = {}
  for (const key of NIGHTLY_METADATA_KEYS) {
    entries[key] = { before: encode(await store.get(key)), after: encode(metadata[key]) }
  }
  const journal = Buffer.from(JSON.stringify({ schema: 1, candidate, entries }))
  await verifyWrite(store, NIGHTLY_JOURNAL_KEY, journal)
  try {
    for (const key of NIGHTLY_METADATA_KEYS) await verifyWrite(store, key, metadata[key])
    await verifyWrite(store, NIGHTLY_JOURNAL_KEY, null)
    return { state: 'committed' }
  } catch (error) {
    try {
      const recovery = await recoverNightlyMetadata(store)
      if (recovery.state === 'committed') return recovery
    } catch (recoveryError) {
      const failure = new AggregateError(
        [error, recoveryError],
        'Nightly publication failed; durable recovery is pending',
        { cause: recoveryError }
      )
      throw failure
    }
    throw error
  }
}
