import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveNightlyCandidate,
  inspectNightlyPublication,
  nightlyCandidateEnvironment,
  validateNightlyCandidate,
  githubApi
} from './nightly-candidate.mjs'
const sha = (n) => n.repeat(40)
const context = {
  repository: 'LodyAI/Lody',
  ref: 'refs/heads/main',
  eventName: 'schedule',
  sha: sha('a'),
  runId: '100',
  runNumber: '42',
  runAttempt: '1'
}
const options = { context, event: {}, now: new Date('2026-11-21T00:00:00.000Z') }
test('freezes a scheduled or manual main commit without querying another repository', async () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const candidate = await resolveNightlyCandidate({
      ...options,
      context: { ...context, eventName },
      api: () => {
        throw new Error('Unexpected API call')
      }
    })
    assert.equal(candidate.sourceSha, context.sha)
    assert.equal(candidate.trigger.repository, 'LodyAI/Lody')
    assert.equal(nightlyCandidateEnvironment(candidate).LODY_SOURCE_SHA, context.sha)
    assert.equal(candidate.builtAt, options.now.toISOString())
    assert.deepEqual(validateNightlyCandidate(candidate), candidate)
  }
})
test('retries reuse the original identity and reject missing or changed candidates', async () => {
  const candidate = await resolveNightlyCandidate(options)
  assert.equal(
    await resolveNightlyCandidate({
      ...options,
      context: { ...context, runAttempt: '2' },
      previous: candidate,
      now: new Date()
    }),
    candidate
  )
  await assert.rejects(
    resolveNightlyCandidate({ ...options, context: { ...context, runAttempt: '2' } }),
    /original candidate/
  )
  for (const patch of [{ sha: sha('b') }, { runId: '101' }, { runNumber: '43' }]) {
    await assert.rejects(
      resolveNightlyCandidate({
        ...options,
        context: { ...context, ...patch },
        previous: candidate
      })
    )
  }
})
test('rejects unexpected repositories, branches, triggers and malformed identities', async () => {
  for (const patch of [
    { repository: 'other/repo' },
    { ref: 'refs/heads/release' },
    { eventName: 'pull_request' },
    { sha: 'main' },
    { runNumber: '0' }
  ]) {
    await assert.rejects(resolveNightlyCandidate({ ...options, context: { ...context, ...patch } }))
  }
})
test('publication skips no-op and superseded builds and rejects divergent main', async () => {
  const candidate = await resolveNightlyCandidate(options)
  const previous = {
    ...candidate,
    sourceSha: sha('9'),
    trigger: { ...candidate.trigger, sha: sha('9') },
    buildNumber: '41'
  }
  const api = async (endpoint) =>
    endpoint.includes('/compare/')
      ? {
          status: 'ahead',
          merge_base_commit: { sha: endpoint.includes(sha('9')) ? sha('9') : sha('a') }
        }
      : { object: { sha: sha('b') } }
  assert.deepEqual(await inspectNightlyPublication({ candidate, api }), {
    publish: true,
    reason: 'eligible'
  })
  assert.equal(
    (await inspectNightlyPublication({ candidate, published: candidate, api })).reason,
    'already-published'
  )
  assert.equal(
    (
      await inspectNightlyPublication({
        candidate,
        published: { ...previous, buildNumber: '43' },
        api
      })
    ).reason,
    'superseded-build'
  )
  assert.equal(
    (await inspectNightlyPublication({ candidate, published: previous, api })).publish,
    true
  )
  await assert.rejects(
    inspectNightlyPublication({
      candidate,
      published: previous,
      api: async () => ({ status: 'diverged' })
    }),
    /ancestor/
  )
})
test('GitHub adapter rejects cross-repository access before sending a request', async () => {
  const api = githubApi('synthetic-token', () => {
    throw new Error('Unexpected request')
  })
  await assert.rejects(api('repos/other/repo/git/ref/heads/main'), /repository/)
})

test('cutover accepts a monotonic native build override and fences historical records by the public source', async () => {
  const candidate = await resolveNightlyCandidate({
    ...options,
    context: { ...context, buildNumber: '10000' }
  })
  assert.equal(candidate.buildNumber, '10000')
  const published = {
    schema: 1,
    privateSha: sha('8'),
    ossSha: sha('9'),
    buildNumber: '9999',
    runId: '99',
    builtAt: '2026-11-20T00:00:00.000Z',
    trigger: { repository: 'loro-dev/lody', sha: sha('8') }
  }
  const api = async (endpoint) => {
    assert.ok(endpoint.startsWith('repos/LodyAI/Lody/'))
    return endpoint.includes('/compare/')
      ? { status: 'ahead', merge_base_commit: { sha: sha('9') } }
      : { object: { sha: candidate.sourceSha } }
  }
  assert.equal((await inspectNightlyPublication({ candidate, published, api })).publish, true)
  assert.equal(
    (
      await inspectNightlyPublication({
        candidate: { ...candidate, buildNumber: '42' },
        published,
        api
      })
    ).reason,
    'superseded-build'
  )
})

test('Track C public schema-1 wire candidates export the single public source and reject mismatched SHA pairs', async () => {
  const canonical = await resolveNightlyCandidate(options)
  const { sourceSha, ...rest } = canonical
  const wire = { ...rest, privateSha: sourceSha, ossSha: sourceSha }
  assert.equal(validateNightlyCandidate(wire), wire)
  assert.equal(nightlyCandidateEnvironment(wire).LODY_SOURCE_SHA, sourceSha)
  assert.equal(
    (
      await inspectNightlyPublication({
        candidate: wire,
        api: async () => ({ object: { sha: sourceSha } })
      })
    ).publish,
    true
  )
  assert.throws(() => validateNightlyCandidate({ ...wire, privateSha: sha('b') }))
})
