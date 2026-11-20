import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeNativeSessionRead } from './native-session-read.ts'

// Synthetic encrypted workspace: "me" owns machine-a; "other" owns machine-b.
const rows = {
  'machine-a': { id: 'a', ownerUserId: 'me' },
  'machine-b': { id: 'b', ownerUserId: 'other' },
  'session-mine': { machineId: 'a', userId: 'me' },
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
  ownerMembershipId: 'm',
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
const access = (views = {}) => ({
  accountId: 'me',
  readMachineSharing: async (machineId) => views[machineId] ?? view(machineId)
})
const read = (docId, views) => authorizeNativeSessionRead(access(views), meta, 'ws', docId)
const denied = { message: 'native_doc_read_denied' }

void test('main admits only Sessions the session read rules make visible to this member', async () => {
  await read('session-mine')
  await read('session-assigned')
  // Another member's private Session on an unshared machine is not readable.
  await assert.rejects(read('session-private'), denied)
  await assert.rejects(read('session-missing'), denied)
  // A team read grant admits that Session and its Side Chat, nothing else.
  const granted = {
    b: view('b', { sessions: [{ sessionId: 'granted', audience: 'team', level: 'read' }] })
  }
  await read('session-granted', granted)
  await read('session-side', granted)
  await assert.rejects(read('session-private', granted), denied)
  // A removed or unverified policy grants nothing.
  await assert.rejects(read('session-granted', { b: { ...granted.b, unavailable: true } }), denied)
  // A team-shared machine opens its Sessions; a local project needs its own switch.
  const shared = { b: view('b', { sharedWithTeam: true }) }
  await read('session-private', shared)
  await assert.rejects(read('session-project', shared), denied)
  await read('session-project', { b: view('b', { sharedWithTeam: true, projects: ['p1'] }) })
  // Workspace-wide documents are scoped by admission alone.
  await read('schedule-anything')
})
