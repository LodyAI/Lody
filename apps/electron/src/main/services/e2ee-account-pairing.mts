import type { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import {
  makeAccountPairing,
  type AccountPairingAdmissionRecord,
  type AccountPairingApproverWorkspace,
  type AccountPairingRelay,
  type AccountPairingRequesterWorkspace,
  type AccountPairingStore
} from '@lody/e2ee-client/account-pairing'
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'

export type {
  AccountPairingApproval,
  AccountPairingApproverWorkspace,
  AccountPairingPreview,
  AccountPairingRefusal,
  AccountPairingRelay,
  AccountPairingRequesterWorkspace,
  AccountPairingState
} from '@lody/e2ee-client/account-pairing'

/**
 * The desktop's SQLite implementation of the shared account pairing store. It owns
 * only its `account_pairing_*` tables in the account's E2EE database; every
 * statement commits before the effect resolves. No secret or private key is stored.
 */
export function makeSqliteAccountPairingStore(db: DatabaseSync): AccountPairingStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_pairing_terminal(lookup_id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN('requester','approver')),state TEXT NOT NULL CHECK(state IN('approved','declined','expired','cancelled')),settled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_pairing_requests(lookup_id TEXT PRIMARY KEY,request BLOB NOT NULL,request_tag TEXT NOT NULL,direction TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS account_pairing_joined(lookup_id TEXT NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(lookup_id,workspace_id));
    CREATE TABLE IF NOT EXISTS account_pairing_approved_requests(lookup_id TEXT PRIMARY KEY,request BLOB NOT NULL,request_tag TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_pairing_admissions(workspace_id TEXT NOT NULL,signing_key TEXT NOT NULL,genesis TEXT NOT NULL,lookup_id TEXT NOT NULL,request_id TEXT NOT NULL,record BLOB NOT NULL,invitation BLOB,PRIMARY KEY(workspace_id,signing_key));
  `)
  function sql<A>(work: () => A): Effect.Effect<A, unknown> {
    return Effect.try({ try: work, catch: (error) => error })
  }
  type AdmissionRow = {
    workspace_id: string
    signing_key: string
    genesis: string
    lookup_id: string
    request_id: string
    record: Uint8Array
    invitation: Uint8Array | null
  }
  const admission = (row: AdmissionRow): AccountPairingAdmissionRecord => ({
    workspaceId: row.workspace_id,
    signingKey: row.signing_key,
    genesis: row.genesis,
    lookupId: row.lookup_id,
    requestId: row.request_id,
    record: new Uint8Array(row.record),
    invitation: row.invitation ? new Uint8Array(row.invitation) : null
  })
  return {
    terminal: (lookupId) =>
      sql(() => {
        const row = db
          .prepare('SELECT state FROM account_pairing_terminal WHERE lookup_id=?')
          .get(lookupId) as { state: 'approved' | 'declined' | 'expired' | 'cancelled' } | undefined
        return row?.state ?? null
      }),
    settle: (lookupId, role, state, at) =>
      sql(() => {
        db.prepare(
          'INSERT OR IGNORE INTO account_pairing_terminal(lookup_id,role,state,settled_at) VALUES(?,?,?,?)'
        ).run(lookupId, role, state, at)
      }),
    latestRequest: () =>
      sql(() => {
        const row = db
          .prepare('SELECT * FROM account_pairing_requests ORDER BY rowid DESC LIMIT 1')
          .get() as
          | {
              lookup_id: string
              request: Uint8Array
              request_tag: string
              direction: string
              expires_at: number
            }
          | undefined
        return row
          ? {
              lookupId: row.lookup_id,
              request: new Uint8Array(row.request),
              requestTag: row.request_tag,
              direction: row.direction,
              expiresAt: row.expires_at
            }
          : null
      }),
    hasRequest: (lookupId) =>
      sql(
        () =>
          db.prepare('SELECT 1 FROM account_pairing_requests WHERE lookup_id=?').get(lookupId) !==
          undefined
      ),
    insertRequest: (record) =>
      sql(() => {
        db.prepare(
          'INSERT INTO account_pairing_requests(lookup_id,request,request_tag,direction,expires_at) VALUES(?,?,?,?,?)'
        ).run(
          record.lookupId,
          record.request,
          record.requestTag,
          record.direction,
          record.expiresAt
        )
      }),
    joined: (lookupId) =>
      sql(
        () =>
          new Set(
            (
              db
                .prepare('SELECT workspace_id FROM account_pairing_joined WHERE lookup_id=?')
                .all(lookupId) as { workspace_id: string }[]
            ).map((row) => row.workspace_id)
          )
      ),
    addJoined: (lookupId, workspaceId) =>
      sql(() => {
        db.prepare(
          'INSERT OR IGNORE INTO account_pairing_joined(lookup_id,workspace_id) VALUES(?,?)'
        ).run(lookupId, workspaceId)
      }),
    approvedRequest: (lookupId) =>
      sql(() => {
        const row = db
          .prepare(
            'SELECT request,request_tag FROM account_pairing_approved_requests WHERE lookup_id=?'
          )
          .get(lookupId) as { request: Uint8Array; request_tag: string } | undefined
        return row ? { request: new Uint8Array(row.request), requestTag: row.request_tag } : null
      }),
    putApprovedRequest: (lookupId, request, requestTag) =>
      sql(() => {
        db.prepare(
          'INSERT OR IGNORE INTO account_pairing_approved_requests(lookup_id,request,request_tag) VALUES(?,?,?)'
        ).run(lookupId, request, requestTag)
      }),
    admission: (workspaceId, signingKey) =>
      sql(() => {
        const row = db
          .prepare(
            'SELECT * FROM account_pairing_admissions WHERE workspace_id=? AND signing_key=?'
          )
          .get(workspaceId, signingKey) as AdmissionRow | undefined
        return row ? admission(row) : null
      }),
    insertAdmission: (record) =>
      sql(() => {
        db.prepare(
          'INSERT INTO account_pairing_admissions(workspace_id,signing_key,genesis,lookup_id,request_id,record) VALUES(?,?,?,?,?,?)'
        ).run(
          record.workspaceId,
          record.signingKey,
          record.genesis,
          record.lookupId,
          record.requestId,
          record.record
        )
      }),
    setAdmissionInvitation: (workspaceId, signingKey, invitation) =>
      sql(() => {
        db.prepare(
          'UPDATE account_pairing_admissions SET invitation=? WHERE workspace_id=? AND signing_key=? AND invitation IS NULL'
        ).run(invitation, workspaceId, signingKey)
      }),
    deleteAdmission: (workspaceId, signingKey, requestId) =>
      sql(() => {
        db.prepare(
          'DELETE FROM account_pairing_admissions WHERE workspace_id=? AND signing_key=? AND request_id=?'
        ).run(workspaceId, signingKey, requestId)
      }),
    admissionCount: (lookupId) =>
      sql(
        () =>
          (
            db
              .prepare('SELECT COUNT(*) AS n FROM account_pairing_admissions WHERE lookup_id=?')
              .get(lookupId) as { n: number }
          ).n
      )
  }
}

/** The shared workflow over the desktop's SQLite store and local diagnostics. */
export function makeDesktopAccountPairing(input: {
  /** The account's E2EE database; this module owns only its `account_pairing_*` tables. */
  db: DatabaseSync
  account: string
  deviceName: string
  relay: AccountPairingRelay
  approverWorkspaces: () => Effect.Effect<readonly AccountPairingApproverWorkspace[], unknown>
  requesterWorkspaces: () => Effect.Effect<readonly AccountPairingRequesterWorkspace[], unknown>
  now?: () => number
  random?: (size: number) => Uint8Array
}) {
  const { db, ...rest } = input
  return makeAccountPairing({
    ...rest,
    store: makeSqliteAccountPairingStore(db),
    diagnostics: rememberDesktopE2eeFailure
  })
}
