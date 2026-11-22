import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const REPOSITORY = 'LodyAI/Lody'
export function requireSha(value, name = 'SHA') {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new Error(`${name}: expected a full commit SHA`)
  return value
}
async function requireAncestor(api, base, head) {
  if (base === head) return
  const comparison = await api(`repos/${REPOSITORY}/compare/${base}...${head}`)
  assert.ok(
    ['ahead', 'identical'].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === base,
    'Nightly source is not an ancestor'
  )
}
export const MAX_NIGHTLY_BUILD_NUMBER = 99_989_999

function requirePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER, name = 'Integer') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value) || Number(value) > maximum) {
    throw new Error(`${name}: expected a positive integer within the supported range`)
  }
  return value
}

/** Shared by candidate admission and the packaging profile; no dependencies or secrets required. */
export function validateNightlyBuildIdentity(identity) {
  requireSha(identity.sourceSha, 'LODY_SOURCE_SHA')
  requirePositiveInteger(
    identity.buildNumber,
    MAX_NIGHTLY_BUILD_NUMBER,
    'LODY_NIGHTLY_BUILD_NUMBER'
  )
  requirePositiveInteger(identity.runId, Number.MAX_SAFE_INTEGER, 'LODY_BUILD_RUN_ID')
  if (
    typeof identity.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(identity.builtAt)) ||
    new Date(identity.builtAt).toISOString() !== identity.builtAt
  ) {
    throw new Error('LODY_BUILD_TIMESTAMP: expected a canonical ISO build timestamp')
  }
}

function triggerFromContext(context, event) {
  assert.equal(context.repository, REPOSITORY, 'Nightly requires LodyAI/Lody')
  assert.equal(context.ref, 'refs/heads/main', 'Nightly requires main')
  assert.ok(
    ['schedule', 'workflow_dispatch'].includes(context.eventName),
    'Unexpected Nightly trigger'
  )
  if (event.repository) assert.equal(event.repository.full_name, REPOSITORY)
  requireSha(context.sha, 'GITHUB_SHA')
  return { repository: REPOSITORY, sha: context.sha }
}

export function validateNightlyCandidate(candidate) {
  if (candidate?.sourceSha === undefined) {
    validateStoredNightlyCandidate(candidate)
    assert.equal(candidate.trigger.repository, REPOSITORY)
    assert.equal(candidate.privateSha, candidate.ossSha)
    assert.equal(candidate.ossSha, candidate.trigger.sha)
    return candidate
  }

  assert.deepEqual(Object.keys(candidate).sort(), [
    'buildNumber',
    'builtAt',
    'runId',
    'schema',
    'sourceSha',
    'trigger'
  ])
  if (candidate.schema !== 1) throw new Error('Unsupported Nightly candidate schema')
  validateNightlyBuildIdentity(candidate)
  assert.deepEqual(Object.keys(candidate.trigger).sort(), ['repository', 'sha'])
  if (candidate.trigger.repository !== REPOSITORY) {
    throw new Error('Invalid candidate trigger repository')
  }
  requireSha(candidate.trigger.sha)
  assert.equal(
    candidate.sourceSha ?? candidate.ossSha,
    candidate.trigger.sha,
    'Candidate source differs from trigger'
  )
  return candidate
}

/** Historical records remain readable for journal recovery and version floors only. */
export function validateStoredNightlyCandidate(candidate) {
  if (candidate?.sourceSha !== undefined) return validateNightlyCandidate(candidate)
  assert.deepEqual(Object.keys(candidate).sort(), [
    'buildNumber',
    'builtAt',
    'ossSha',
    'privateSha',
    'runId',
    'schema',
    'trigger'
  ])
  assert.equal(candidate.schema, 1)
  requireSha(candidate.privateSha)
  requireSha(candidate.ossSha)
  validateNightlyBuildIdentity({ ...candidate, sourceSha: candidate.ossSha })
  assert.deepEqual(Object.keys(candidate.trigger).sort(), ['repository', 'sha'])
  assert.ok(['loro-dev/lody', REPOSITORY].includes(candidate.trigger.repository))
  requireSha(candidate.trigger.sha)
  return candidate
}

/** Freeze the triggering main commit; retries must reuse its original candidate. */
export async function resolveNightlyCandidate({ context, event, api, previous, now = new Date() }) {
  const trigger = triggerFromContext(context, event)
  requirePositiveInteger(context.runAttempt)
  requirePositiveInteger(context.runId)
  requirePositiveInteger(context.buildNumber ?? context.runNumber, MAX_NIGHTLY_BUILD_NUMBER)
  if (previous !== undefined) {
    validateNightlyCandidate(previous)
    assert.equal(previous.runId, context.runId, 'Candidate belongs to another workflow run')
    assert.equal(
      previous.buildNumber,
      context.buildNumber ?? context.runNumber,
      'Candidate build number changed'
    )
    assert.deepEqual(previous.trigger, trigger, 'Candidate trigger changed')
    assert.equal(previous.sourceSha ?? previous.ossSha, trigger.sha, 'Candidate merge SHA changed')
    return previous
  }
  if (context.runAttempt !== '1') {
    throw new Error('Retry requires the original candidate artifact; refusing to resolve new heads')
  }
  const sourceSha = trigger.sha
  return validateNightlyCandidate({
    schema: 1,
    sourceSha,
    buildNumber: context.buildNumber ?? context.runNumber,
    runId: context.runId,
    builtAt: now.toISOString(),
    trigger
  })
}

/** Call under the publication lock, after recovering any interrupted metadata transaction. */
export async function inspectNightlyPublication({ candidate, published, api }) {
  validateNightlyCandidate(candidate)
  if (published !== undefined) {
    validateStoredNightlyCandidate(published)
    if ((published.sourceSha ?? published.ossSha) === (candidate.sourceSha ?? candidate.ossSha)) {
      return { publish: false, reason: 'already-published' }
    }
    if (Number(candidate.buildNumber) <= Number(published.buildNumber)) {
      return { publish: false, reason: 'superseded-build' }
    }
    await requireAncestor(
      api,
      published.sourceSha ?? published.ossSha,
      candidate.sourceSha ?? candidate.ossSha
    )
  }
  const head = requireSha((await api(`repos/${REPOSITORY}/git/ref/heads/main`)).object?.sha)
  await requireAncestor(api, candidate.sourceSha ?? candidate.ossSha, head)
  return { publish: true, reason: 'eligible' }
}

export function nightlyCandidateEnvironment(candidate) {
  validateNightlyCandidate(candidate)
  return {
    LODY_ENV: 'production',
    LODY_RELEASE_CHANNEL: 'nightly',
    LODY_SOURCE_SHA: candidate.sourceSha ?? candidate.ossSha,
    LODY_NIGHTLY_BUILD_NUMBER: candidate.buildNumber,
    LODY_BUILD_RUN_ID: candidate.runId,
    LODY_BUILD_TIMESTAMP: candidate.builtAt
  }
}

export function githubApi(token, fetchImpl = fetch) {
  if (!token) throw new Error('GitHub read token is required')
  return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
    if (!path.startsWith(`repos/${REPOSITORY}/`))
      throw new Error('Unexpected GitHub API repository')
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) {
      const error = new Error(`GitHub request failed (HTTP ${response.status})`)
      error.status = response.status
      throw error
    }
    return response.json()
  }
}

async function main() {
  const [command, filename] = process.argv.slice(2)
  if (!filename || !['resolve', 'export'].includes(command)) {
    throw new Error('Usage: node nightly-candidate.mjs resolve|export <candidate.json>')
  }
  let candidate
  try {
    candidate = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' || command !== 'resolve') throw error
  }
  if (command === 'resolve') {
    const previous = candidate
    candidate = await resolveNightlyCandidate({
      context: {
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        eventName: process.env.GITHUB_EVENT_NAME,
        sha: process.env.GITHUB_SHA,
        runId: process.env.GITHUB_RUN_ID,
        runNumber: process.env.GITHUB_RUN_NUMBER,
        buildNumber: process.env.LODY_NIGHTLY_BUILD_NUMBER,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT
      },
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
      previous,
      api: githubApi(process.env.GH_TOKEN)
    })
    if (previous === undefined)
      await writeFile(filename, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' })
  }
  const environment = nightlyCandidateEnvironment(candidate)
  if (command === 'export') {
    if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required')
    await appendFile(
      process.env.GITHUB_ENV,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    )
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `source-sha=${candidate.sourceSha ?? candidate.ossSha}\n`
    )
  }
  console.log(JSON.stringify(candidate, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
