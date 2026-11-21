import assert from 'node:assert/strict'
import {
  inspectNightlyPublication,
  validateNightlyCandidate,
  validateStoredNightlyCandidate
} from './nightly-candidate.mjs'

export const NIGHTLY_VERSION_KEY = '_nightly-version.json'
export const NIGHTLY_VERSION_SCHEME = 'minor-cycle'

const component = '(0|[1-9]\\d{0,7})'
const basePattern = new RegExp(
  `^${component}\\.${component}\\.${component}(?:-next\\.${component})?$`,
  'u'
)
const nightlyPattern = new RegExp(
  `^${component}\\.${component}\\.${component}-nightly\\.${component}$`,
  'u'
)

export function nightlyVersionBase(baseVersion) {
  const parts = typeof baseVersion === 'string' && basePattern.exec(baseVersion)
  if (!parts || Number(parts[2]) === 99_999_999) throw new Error('Invalid Nightly base version')
  return `${parts[1]}.${Number(parts[2]) + 1}.0`
}

function versionParts(version) {
  const parts = typeof version === 'string' && nightlyPattern.exec(version)
  if (!parts) throw new Error('Invalid LODY_NIGHTLY_VERSION')
  return parts.slice(1).map(Number)
}

export function validateNightlyVersion(version, baseVersion) {
  const parts = versionParts(version)
  if (parts[2] !== 0) throw new Error('LODY_NIGHTLY_VERSION must have patch zero')
  if (baseVersion !== undefined && version.split('-')[0] !== nightlyVersionBase(baseVersion))
    throw new Error('LODY_NIGHTLY_VERSION does not match the next minor version')
  return version
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  return a.map((part, index) => part - b[index]).find((part) => part !== 0) ?? 0
}

async function readReservation(store) {
  const bytes = await store.get(NIGHTLY_VERSION_KEY)
  if (bytes === null) return undefined
  const record = JSON.parse(bytes)
  assert.deepEqual(Object.keys(record).sort(), ['candidate', 'schema', 'version'])
  assert.equal(record.schema, 1, 'Unsupported Nightly version reservation')
  validateStoredNightlyCandidate(record.candidate)
  validateNightlyVersion(record.version)
  return record
}

/** Called only after feed recovery/admission, under the workflow-wide Nightly lock. */
export async function reserveNightlyVersion({ store, candidate, baseVersion, api }) {
  validateNightlyCandidate(candidate)
  const cycle = nightlyVersionBase(baseVersion)
  const previous = await readReservation(store)
  const publishedBytes = await store.get('version.json')
  const published = publishedBytes === null ? undefined : JSON.parse(publishedBytes)
  if (published !== undefined) {
    validateStoredNightlyCandidate(published.candidate)
    versionParts(published.version)
    if (published.versionScheme === NIGHTLY_VERSION_SCHEME && previous === undefined)
      throw new Error('Nightly version reservation is missing; refusing to reuse numbers')
    if (previous !== undefined) {
      assert.ok(
        Number(previous.candidate.buildNumber) >= Number(published.candidate.buildNumber) &&
          compareVersions(previous.version, published.version) >= 0,
        'Nightly version reservation is behind the published release'
      )
      if (previous.candidate.buildNumber === published.candidate.buildNumber) {
        assert.deepEqual(previous.candidate, published.candidate)
        assert.equal(previous.version, published.version)
      }
    }
  }
  if (
    previous?.candidate.trigger.repository === candidate.trigger.repository &&
    previous.candidate.runId === candidate.runId
  ) {
    assert.deepEqual(previous.candidate, candidate, 'Reserved Nightly candidate changed')
    validateNightlyVersion(previous.version, baseVersion)
    return { publish: true, version: previous.version }
  }
  if (previous !== undefined) {
    if (Number(candidate.buildNumber) <= Number(previous.candidate.buildNumber))
      return { publish: false, reason: 'superseded-reservation' }
    await inspectNightlyPublication({ candidate, published: previous.candidate, api })
  }
  const sequence =
    previous?.version.split('-')[0] === cycle ? versionParts(previous.version)[3] + 1 : 0
  const version = validateNightlyVersion(`${cycle}-nightly.${sequence}`, baseVersion)
  for (const earlier of [previous?.version, published?.version]) {
    if (earlier !== undefined && compareVersions(version, earlier) <= 0)
      throw new Error('Nightly display version must increase; refusing an older version cycle')
  }
  const record = { schema: 1, candidate, version }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  await store.put(NIGHTLY_VERSION_KEY, bytes)
  assert.deepEqual(
    await store.get(NIGHTLY_VERSION_KEY),
    bytes,
    'Nightly reservation readback failed'
  )
  return { publish: true, version }
}

export async function assertNightlyVersionReservation({ store, candidate, displayVersion }) {
  const record = await readReservation(store)
  assert.ok(record, 'Missing Nightly version reservation')
  assert.deepEqual(record.candidate, candidate, 'Nightly version belongs to another candidate')
  assert.equal(record.version, displayVersion, 'Nightly version differs from its reservation')
}
