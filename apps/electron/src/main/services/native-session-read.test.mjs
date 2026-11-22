import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NativeDocCommitSchema,
  NativeDocLegacySchema,
  NativeDocOpenSchema
} from '@lody/shared/native-workspace-meta-ipc'
import { authorizeNativeSessionAccess } from './native-session-read.ts'
import { createNativeViews } from './native-views.ts'

/**
 * Synthetic encrypted workspace. The verified ledger says "me" (membership "mine")
 * owns machine-a and another member owns machine-b. Meta ownership fields are
 * untrusted: machine-a (paired, no account key) has none, and machine-b carries a
 * forged claim that "me" owns it.
 */
const rows = {
  'machine-a': { id: 'a' },
  'machine-b': { id: 'b', ownerUserId: 'me' },
  'session-mine': { machineId: 'a', userId: 'automation' },
  'session-private': { machineId: 'b', userId: 'other' },
  'session-granted': { machineId: 'b', userId: 'other' },
  'session-side': {
    machineId: 'b',
    userId: 'other',
    parentSessionId: 'granted',
    childSessionPlacement: 'side-panel'
  },
  'session-assigned': { machineId: 'b', userId: 'me' },
  'session-project': {
    machineId: 'b',
    userId: 'other',
    project: { kind: 'local', localProjectId: 'p1' }
  }
}
const meta = {
  readDoc: async (docId) =>
    rows[docId] ? { docId, deleted: false, meta: { ...rows[docId] } } : undefined
}
const view = (machineId, change = {}) => ({
  machineId,
  ownerMembershipId: machineId === 'a' ? 'mine' : 'theirs',
  generation: 'g',
  head: null,
  sharedWithTeam: false,
  projects: [],
  sessions: [],
  canManage: false,
  signer: null,
  needsResign: false,
  ...change
})
const access = (views = {}, change = {}) => ({
  accountId: 'me',
  membershipId: 'mine',
  mayWrite: true,
  readMachineSharing: async (machineId) => views[machineId] ?? view(machineId),
  ...change
})
const read = (docId, views, change) =>
  authorizeNativeSessionAccess(access(views, change), meta, 'ws', docId, 'read')
const write = (docId, views, change) =>
  authorizeNativeSessionAccess(access(views, change), meta, 'ws', docId, 'write')
const denied = { message: 'native_doc_read_denied' }
const writeDenied = { message: 'native_doc_write_denied' }
const granted = {
  b: view('b', { sessions: [{ sessionId: 'granted', audience: 'team', level: 'read' }] })
}

void test('main admits only Sessions the session read rules make visible to this member', async () => {
  await read('session-mine')
  await read('session-assigned')
  await assert.rejects(read('session-private'), denied)
  await assert.rejects(read('session-missing'), denied)
  await read('session-granted', granted)
  await read('session-side', granted)
  await assert.rejects(read('session-private', granted), denied)
  await assert.rejects(read('session-granted', { b: { ...granted.b, unavailable: true } }), denied)
  const shared = { b: view('b', { sharedWithTeam: true }) }
  await read('session-private', shared)
  await assert.rejects(read('session-project', shared), denied)
  await read('session-project', { b: view('b', { sharedWithTeam: true, projects: ['p1'] }) })
  await read('schedule-anything')
})

void test('machine ownership comes from the verified ledger, never a Meta field', async () => {
  await read('session-mine')
  await assert.rejects(read('session-private'), denied)
  await assert.rejects(read('session-mine', {}, { membershipId: null }), denied)
  await assert.rejects(read('session-mine', { a: view('a', { removed: true }) }), denied)
})

void test('a write needs edit rights: a read grant or a Guest seat writes nothing', async () => {
  await write('session-mine')
  await assert.rejects(write('session-granted', granted), writeDenied)
  await assert.rejects(write('session-assigned'), writeDenied)
  await assert.rejects(write('session-mine', {}, { mayWrite: false }), writeDenied)
  await write('session-private', { b: view('b', { sharedWithTeam: true }) })
  await assert.rejects(
    write('session-project', { b: view('b', { sharedWithTeam: true }) }),
    writeDenied
  )
})

void test('a Preview comment document follows the rules of its Session', async () => {
  await read('preview-comment-mine')
  await write('preview-comment-mine')
  await assert.rejects(read('preview-comment-private'), denied)
  await read('preview-comment-granted', granted)
  await assert.rejects(write('preview-comment-granted', granted), writeDenied)
  await assert.rejects(read('preview-comment-missing'), denied)
})

void test('raw Loro updates and legacy imports never reach a Session document', () => {
  const target = { workspaceId: 'ws', observationId: '00000000-0000-4000-8000-000000000000' }
  for (const docId of ['session-x', 'session-comment-x', 'meta', 'other-x'])
    assert.equal(NativeDocOpenSchema.safeParse({ ...target, docId }).success, false, docId)
  for (const docId of ['schedule-x', 'preview-comment-x'])
    assert.equal(NativeDocOpenSchema.safeParse({ ...target, docId }).success, true, docId)
  const updates = [new Uint8Array([1])]
  assert.equal(
    NativeDocCommitSchema.safeParse({ workspaceId: 'ws', docId: 'session-x', updates }).success,
    false
  )
  assert.equal(
    NativeDocLegacySchema.safeParse({
      workspaceId: 'ws',
      docId: 'session-x',
      source: 'renderer:db',
      snapshot: new Uint8Array(),
      version: {}
    }).success,
    false
  )
})

/** A view whose establishment the test completes by hand. */
function pendingView() {
  let finish
  const established = new Promise((resolve) => (finish = resolve))
  const view = { released: 0 }
  return {
    view,
    finish: () => finish(),
    start: async () => {
      await established
      return { release: () => (view.released += 1), value: 'snapshot' }
    }
  }
}

void test('a view established across an access loss is released and never returned', async () => {
  const views = createNativeViews()
  const window = {}
  const pending = pendingView()
  const generation = views.generation('ws')
  const opening = views.establish({
    owner: window,
    workspaceId: 'ws',
    generation,
    observationId: 'o1',
    limit: 4,
    start: pending.start
  })
  views.loseAccess('ws')
  pending.finish()
  await assert.rejects(opening, { message: 'native_access_lost' })
  assert.equal(pending.view.released, 1)
  views.drop(window)
  assert.equal(pending.view.released, 1)
  const late = pendingView()
  late.finish()
  await assert.rejects(
    views.establish({
      owner: window,
      workspaceId: 'ws',
      generation,
      observationId: 'o2',
      limit: 4,
      start: late.start
    }),
    { message: 'native_access_lost' }
  )
  assert.equal(late.view.released, 0)
})

void test('access loss releases established views and discards replies in flight', async () => {
  const views = createNativeViews()
  const window = {}
  const kept = pendingView()
  kept.finish()
  const other = pendingView()
  other.finish()
  const at = views.generation('ws')
  assert.equal(
    await views.establish({
      owner: window,
      workspaceId: 'ws',
      generation: at,
      observationId: 'o1',
      limit: 4,
      start: kept.start
    }),
    'snapshot'
  )
  await views.establish({
    owner: window,
    workspaceId: 'other',
    generation: views.generation('other'),
    observationId: 'o2',
    limit: 4,
    start: other.start
  })
  let writes = 0
  let release
  const blocked = new Promise((resolve) => (release = resolve))
  const reply = views.fenced('ws', async (check) => {
    await blocked
    check()
    writes += 1
    return 'late'
  })
  views.loseAccess('ws')
  release()
  await assert.rejects(reply, { message: 'native_access_lost' })
  assert.equal(writes, 0)
  assert.equal(kept.view.released, 1)
  assert.equal(other.view.released, 0)
})
