import { Effect, Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from './foundation/bytes';
import { ContentError } from './foundation/errors';
import { keyId } from './foundation/identifiers';
import { bytesEqual, decodeMachineSharingCbor, encodeMachineSharingCbor } from './foundation/cbor';
import { encodeContentContext, type ContentScope } from './foundation/content-format';
import type { DeviceSigner } from './foundation/signing';
import { decodeMachineId, encodeMachineId } from './ledger/machine-id';
import { contentPermissions, requireLedgerContinuation, type LedgerView } from './ledger';
import {
  requireMachineSharingGeneration,
  type VerifiedMachineSharingGeneration,
} from './machine-sharing-generation';
import { admitDocument, openDocument, sealDocument, type DocumentKey } from './content';

/** Independent trusted resource identity. Membership is an instance, never an account/display ID. */
export interface MachineSharingBinding {
  readonly workspaceId: string;
  readonly genesisHash: string;
  readonly machineId: string;
  readonly ownerMembershipId: string;
  /** Initial admission signing key (hex32) of the current uninterrupted replacement chain. */
  readonly generation: string;
}
/** Complete sharing state. Listed localProjectIds are shared only while the machine switch is on. */
export interface MachineSharingState {
  readonly sharedWithTeam: boolean;
  readonly projects: readonly string[];
  /** Read-only conversation grants, independent of the machine switch. */
  readonly sessions: readonly { readonly sessionId: string; readonly level: 'read' }[];
}
/** A single owner intent; enabling a project also enables the machine atomically. */
export type MachineSharingChange =
  | { readonly kind: 'machine'; readonly sharedWithTeam: boolean }
  | { readonly kind: 'project'; readonly localProjectId: string; readonly sharedWithTeam: boolean }
  | { readonly kind: 'session'; readonly sessionId: string; readonly level: 'read' | null };
/** Complete policy body, inside content-v0 encryption/signature. issuedAt is descriptive, never freshness or admission proof. */
export interface MachineSharingPolicy extends MachineSharingBinding, MachineSharingState {
  readonly revision: number;
  readonly previousDigest: string | null;
  readonly requestId: string;
  readonly signer: string;
  /** Unix milliseconds, descriptive only; never renews execution freshness. */
  readonly issuedAt: number;
}
/** SHA-256 of the complete original encrypted frame, paired with its signed revision. */
export interface MachineSharingHead {
  readonly revision: number;
  readonly digest: string;
}
const verified: unique symbol = Symbol('VerifiedMachineSharingPolicy');
/** Module-created evidence of exact frame, binding, signer and version verification. Not a freshness grant. */
export interface VerifiedMachineSharingPolicy {
  readonly [verified]: true;
  readonly head: MachineSharingHead;
  /** Detached full state; mutating it never changes this evidence. */
  inspect(): MachineSharingPolicy;
}
const policies = new WeakMap<
  VerifiedMachineSharingPolicy,
  { policy: MachineSharingPolicy; ledger: LedgerView }
>();
const domain = () => new TextEncoder().encode('lody-e2ee/machine-sharing/v3\0');
const fail = (code: string) => Result.fail(new ContentError({ code }));
const mapped = <A, E>(value: Result.Result<A, E>, code = 'invalid-policy') =>
  Result.mapError(value, () => new ContentError({ code }));
const hexPattern = (size: number) => new RegExp(`^[0-9a-f]{${size * 2}}$`);
function rawHex(value: unknown, size: number) {
  return typeof value === 'string' && hexPattern(size).test(value)
    ? Result.succeed(Uint8Array.from(value.match(/../g)!, (b) => Number.parseInt(b, 16)))
    : fail('invalid-policy');
}
const identity = (value: unknown) => mapped(encodeMachineId(value));
function projectSet(projects: readonly string[]) {
  return Result.gen(function* () {
    if (!Array.isArray(projects) || projects.length > 4096) return yield* fail('invalid-policy');
    const rows: { text: string; bytes: Uint8Array; hex: string }[] = [];
    for (const text of projects) {
      const bytes = yield* identity(text);
      rows.push({ text, bytes, hex: keyId(bytes) });
    }
    rows.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
    if (rows.some((row, i) => i > 0 && row.hex === rows[i - 1]!.hex))
      return yield* fail('invalid-policy');
    return rows;
  });
}
function sessionSet(sessions: MachineSharingState['sessions']) {
  return Result.gen(function* () {
    if (!Array.isArray(sessions) || sessions.length > 4096) return yield* fail('invalid-policy');
    for (const row of sessions)
      if (!row || row.level !== 'read') return yield* fail('invalid-policy');
    return yield* projectSet(sessions.map((row) => row.sessionId));
  });
}
/** Apply the plaintext-compatible switches without mutating the source. Turning the machine off retains every project record. */
export function updateMachineSharingState(
  state: MachineSharingState,
  change: MachineSharingChange
) {
  return Result.gen(function* () {
    const current = yield* projectSet(state.projects);
    let sessions = (yield* sessionSet(state.sessions)).map((row) => ({
      sessionId: row.text,
      level: 'read' as const,
    }));
    if (
      typeof state.sharedWithTeam !== 'boolean' ||
      (change.kind !== 'session' && typeof change.sharedWithTeam !== 'boolean')
    )
      return yield* fail('invalid-policy');
    let projects = current.map((row) => row.text);
    let sharedWithTeam = state.sharedWithTeam;
    if (change.kind === 'machine') sharedWithTeam = change.sharedWithTeam;
    else if (change.kind === 'project') {
      yield* identity(change.localProjectId);
      projects = projects.filter((id) => id !== change.localProjectId);
      if (change.sharedWithTeam) {
        projects.push(change.localProjectId);
        sharedWithTeam = true;
      }
    } else if (change.kind === 'session') {
      yield* identity(change.sessionId);
      if (change.level !== null && change.level !== 'read') return yield* fail('invalid-policy');
      sessions = sessions.filter((row) => row.sessionId !== change.sessionId);
      if (change.level === 'read') sessions.push({ sessionId: change.sessionId, level: 'read' });
    } else return yield* fail('invalid-policy');
    return Object.freeze({
      sharedWithTeam,
      sessions: Object.freeze(
        (yield* sessionSet(sessions)).map((row) =>
          Object.freeze({ sessionId: row.text, level: 'read' as const })
        )
      ),
      projects: Object.freeze((yield* projectSet(projects)).map((row) => row.text)),
    });
  });
}
/** Canonical, bounded v3 business body. No ledger format change; project order is bytewise UTF-8, duplicates fail. */
export function encodeMachineSharingPolicy(
  policy: MachineSharingPolicy
): Result.Result<Uint8Array, ContentError> {
  return Result.gen(function* () {
    const workspace = yield* identity(policy.workspaceId),
      machine = yield* identity(policy.machineId);
    const genesis = yield* rawHex(policy.genesisHash, 32),
      owner = yield* rawHex(policy.ownerMembershipId, 16);
    const signer = yield* rawHex(policy.signer, 32),
      request = yield* rawHex(policy.requestId, 16);
    const generation = yield* rawHex(policy.generation, 32);
    yield* mapped(Bytes.signingPublicKey(generation));
    yield* mapped(Bytes.signingPublicKey(signer));
    if (
      !Number.isSafeInteger(policy.revision) ||
      policy.revision < 1 ||
      !Number.isSafeInteger(policy.issuedAt) ||
      policy.issuedAt < 0 ||
      typeof policy.sharedWithTeam !== 'boolean' ||
      (policy.revision === 1) !== (policy.previousDigest === null)
    )
      return yield* fail('invalid-policy');
    const previous =
      policy.previousDigest === null ? null : yield* rawHex(policy.previousDigest, 32);
    const projects = yield* projectSet(policy.projects);
    const sessions = yield* sessionSet(policy.sessions);
    return yield* mapped(
      encodeMachineSharingCbor([
        3,
        1,
        workspace,
        genesis,
        machine,
        owner,
        policy.revision,
        previous,
        policy.sharedWithTeam,
        projects.map((row) => row.bytes),
        signer,
        policy.issuedAt,
        request,
        generation,
        sessions.map((row) => [row.bytes, 1]),
      ])
    );
  });
}
/** Decode exact canonical v3 bytes. Does not establish signature, authority, ordering or freshness. */
export function decodeMachineSharingPolicy(
  bytes: Uint8Array
): Result.Result<MachineSharingPolicy, ContentError> {
  return Result.gen(function* () {
    const row = yield* mapped(decodeMachineSharingCbor(bytes));
    if (!Array.isArray(row) || row.length !== 15) return yield* fail('invalid-policy');
    if (row[0] !== 3) return yield* fail('unsupported-policy-version');
    if (row[1] !== 1) return yield* fail('invalid-policy-purpose');
    const [
      ,
      ,
      workspace,
      genesis,
      machine,
      owner,
      revision,
      previous,
      shared,
      projects,
      signer,
      issuedAt,
      request,
      generation,
      sessions,
    ] = row;
    const text = (value: unknown) => mapped(decodeMachineId(value));
    if (
      !(genesis instanceof Uint8Array) ||
      !(owner instanceof Uint8Array) ||
      !(signer instanceof Uint8Array) ||
      !(request instanceof Uint8Array) ||
      !(generation instanceof Uint8Array) ||
      (previous !== null && !(previous instanceof Uint8Array)) ||
      typeof revision !== 'number' ||
      typeof issuedAt !== 'number' ||
      typeof shared !== 'boolean' ||
      !Array.isArray(projects) ||
      !Array.isArray(sessions)
    )
      return yield* fail('invalid-policy');
    const names: string[] = [];
    for (const project of projects) names.push(yield* text(project));
    const grants: { sessionId: string; level: 'read' }[] = [];
    for (const session of sessions) {
      if (!Array.isArray(session) || session.length !== 2 || session[1] !== 1)
        return yield* fail('invalid-policy');
      grants.push(Object.freeze({ sessionId: yield* text(session[0]), level: 'read' }));
    }
    const policy: MachineSharingPolicy = Object.freeze({
      sessions: Object.freeze(grants),
      workspaceId: yield* text(workspace),
      genesisHash: keyId(genesis),
      machineId: yield* text(machine),
      ownerMembershipId: keyId(owner),
      revision,
      previousDigest: previous === null ? null : keyId(previous),
      sharedWithTeam: shared,
      projects: Object.freeze(names),
      signer: keyId(signer),
      issuedAt,
      requestId: keyId(request),
      generation: keyId(generation),
    });
    const encoded = yield* encodeMachineSharingPolicy(policy);
    const canonical = bytesEqual(encoded, bytes);
    encoded.fill(0);
    if (!canonical) return yield* fail('invalid-policy');
    return policy;
  });
}
/** Existing document-update purpose with an exact machine/member resource; callers also use the fixed business signature/AAD domain. */
export function machineSharingContentScope(
  binding: MachineSharingBinding,
  epoch: number
): Result.Result<ContentScope, ContentError> {
  return Result.gen(function* () {
    yield* identity(binding.workspaceId);
    yield* rawHex(binding.genesisHash, 32);
    yield* rawHex(binding.ownerMembershipId, 16);
    yield* mapped(Bytes.signingPublicKey(yield* rawHex(binding.generation, 32)));
    const machine = yield* identity(binding.machineId);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let encoded = '';
    for (let i = 0; i < machine.length; i += 3) {
      const a = machine[i]!,
        b = machine[i + 1],
        c = machine[i + 2];
      encoded += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
      if (b !== undefined) encoded += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
      if (c !== undefined) encoded += alphabet[c & 63];
    }
    const scope: ContentScope = Object.freeze({
      genesis: binding.genesisHash,
      epoch,
      docEpoch: 0,
      purpose: 'doc-update',
      resource: `machine-access:${encoded}:${binding.ownerMembershipId}:${binding.generation}`,
    });
    yield* encodeContentContext(scope);
    return scope;
  });
}
/** Digest exact original frame bytes for server CAS and local high-water pins; hashing alone proves no authority. */
export function machineSharingDigest(frame: Uint8Array): Result.Result<string, ContentError> {
  return frame instanceof Uint8Array && frame.length >= 143 && frame.length <= 256 * 1024 + 143
    ? Result.succeed(keyId(sha256(frame)))
    : fail('invalid-policy-frame');
}
function policyAuthority(
  ledger: LedgerView,
  policy: MachineSharingBinding & { readonly signer: string },
  machineGeneration: VerifiedMachineSharingGeneration
) {
  return Result.gen(function* () {
    yield* mapped(requireLedgerContinuation(ledger, ledger), 'invalid-policy-ledger');
    yield* requireMachineSharingGeneration(ledger, policy, machineGeneration);
    if (keyId(ledger.genesis.toBytes()) !== policy.genesisHash)
      return yield* fail('policy-binding-mismatch');
    const state = ledger.inspectState(),
      signer = state.devices.get(policy.signer);
    const owner = state.members.get(policy.ownerMembershipId);
    const machine = [...state.devices.values()].find(
      (d) => d.kind === 'machine' && d.machineId === policy.machineId
    );
    if (
      !owner ||
      owner.role === 'guest' ||
      !machine ||
      keyId(machine.membershipId.toBytes()) !== policy.ownerMembershipId ||
      !signer ||
      signer.kind !== 'personal' ||
      keyId(signer.membershipId.toBytes()) !== policy.ownerMembershipId
    )
      return yield* fail('policy-signer-ineligible');
    return undefined;
  });
}
function sameBinding(a: MachineSharingBinding, b: MachineSharingBinding) {
  return (
    a.workspaceId === b.workspaceId &&
    a.genesisHash === b.genesisHash &&
    a.machineId === b.machineId &&
    a.ownerMembershipId === b.ownerMembershipId &&
    a.generation === b.generation
  );
}
/** Backend admission without decryption. The authenticated device must be the current machine owner's personal
 * device; verifies the fixed resource/purpose/business domain and returns the original frame digest. The host
 * still atomically enforces DTO metadata, request identity and head CAS; clients verify the encrypted body. */
export function admitMachineSharingFrame(input: {
  readonly ledger: LedgerView;
  readonly binding: MachineSharingBinding;
  readonly epoch: number;
  readonly frame: Uint8Array;
  readonly authenticatedDevice: Bytes.SigningPublicKey;
  readonly machineGeneration: VerifiedMachineSharingGeneration;
}) {
  return Result.gen(function* () {
    const scope = yield* machineSharingContentScope(input.binding, input.epoch);
    yield* policyAuthority(
      input.ledger,
      {
        ...input.binding,
        signer: keyId(input.authenticatedDevice.toBytes()),
      },
      input.machineGeneration
    );
    const digest = yield* machineSharingDigest(input.frame);
    yield* admitDocument(input.ledger, scope, input.frame, input.authenticatedDevice, domain());
    return Object.freeze({ digest });
  });
}
/** Seal a complete owner policy using existing content-v0 document crypto and a fixed additional signature/AAD domain.
 * Captures before async work; checks current owner-personal authority before/after signing. Borrows the document key.
 * Retain the returned original frame for exact retries; this helper performs no publication or CAS. */
export const sealMachineSharingPolicy = Effect.fnUntraced(function* (input: {
  readonly policy: MachineSharingPolicy;
  readonly epoch: number;
  readonly documentKey: DocumentKey;
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, ContentError>;
  readonly machineGeneration: VerifiedMachineSharingGeneration;
}) {
  return yield* Effect.acquireUseRelease(
    Effect.suspend(() => Effect.fromResult(encodeMachineSharingPolicy(input.policy))),
    (plaintext) =>
      Effect.gen(function* () {
        const policy = yield* Effect.fromResult(decodeMachineSharingPolicy(plaintext));
        const scope = yield* Effect.fromResult(machineSharingContentScope(policy, input.epoch));
        const borrowed = input.signer;
        const signer = Object.freeze({
          publicKey: yield* Effect.fromResult(
            mapped(Bytes.signingPublicKey(borrowed.publicKey.toBytes()))
          ),
          sign: borrowed.sign.bind(borrowed),
        });
        if (keyId(signer.publicKey.toBytes()) !== policy.signer)
          return yield* new ContentError({ code: 'policy-signer-ineligible' });
        const lookup = input.ledger;
        const machineGeneration = input.machineGeneration;
        const documentKey = input.documentKey;
        const before = yield* lookup();
        yield* Effect.fromResult(policyAuthority(before, policy, machineGeneration));
        const frame = yield* sealDocument({
          scope,
          documentKey,
          signer,
          plaintext,
          additionalData: domain(),
          ledger: lookup,
        });
        const after = yield* lookup();
        yield* Effect.fromResult(
          mapped(requireLedgerContinuation(before, after), 'invalid-policy-ledger')
        );
        yield* Effect.fromResult(policyAuthority(after, policy, machineGeneration));
        return frame;
      }),
    (plaintext) => Effect.sync(() => plaintext.fill(0))
  );
});
/** Exact latest original and local high-water pin. Parent digests are server CAS metadata,
 * not a client history-chain proof. A cold client may open any positive revision. */
interface OpenPolicyInput {
  readonly machineGeneration: VerifiedMachineSharingGeneration;
  readonly ledger: LedgerView;
  readonly binding: MachineSharingBinding;
  readonly epoch: number;
  readonly documentKey: DocumentKey;
  readonly frame: Uint8Array;
  readonly expectedHead: MachineSharingHead;
  readonly previous: MachineSharingHead | null;
}
function readPolicyFrame(input: OpenPolicyInput) {
  return Result.gen(function* () {
    yield* requireMachineSharingGeneration(input.ledger, input.binding, input.machineGeneration);
    const digest = yield* machineSharingDigest(input.frame);
    if (digest !== input.expectedHead.digest) return yield* fail('policy-version-conflict');
    const scope = yield* machineSharingContentScope(input.binding, input.epoch);
    const opened = yield* openDocument(
      input.ledger,
      scope,
      input.documentKey,
      input.frame,
      domain()
    );
    const decoded = (() => {
      try {
        return decodeMachineSharingPolicy(opened.plaintext);
      } finally {
        opened.plaintext.fill(0);
      }
    })();
    const policy = yield* decoded;
    if (
      !sameBinding(policy, input.binding) ||
      policy.signer !== opened.header.device ||
      keyId(opened.author.memberInstance.toBytes()) !== policy.ownerMembershipId
    )
      return yield* fail('policy-binding-mismatch');
    const head = Object.freeze({ revision: policy.revision, digest });
    const previous = input.previous;
    if (
      head.revision !== input.expectedHead.revision ||
      (previous !== null &&
        (!Number.isSafeInteger(previous.revision) ||
          previous.revision < 1 ||
          !hexPattern(32).test(previous.digest) ||
          head.revision < previous.revision ||
          (head.revision === previous.revision && head.digest !== previous.digest)))
    )
      return yield* fail('policy-version-conflict');
    return { policy, head, signer: opened.author.device };
  });
}
/** Verify/decrypt the latest v3 state against a caller-owned high-water pin, then require
 * the current machine owner's active personal signer. Revision gaps are allowed; the
 * same revision must have the same digest. The host proves latest-read freshness. */
export function openMachineSharingPolicy(
  input: OpenPolicyInput
): Result.Result<VerifiedMachineSharingPolicy, ContentError> {
  return Result.gen(function* () {
    const { policy, head } = yield* readPolicyFrame(input);
    yield* policyAuthority(input.ledger, policy, input.machineGeneration);
    const evidence: VerifiedMachineSharingPolicy = Object.freeze({
      [verified]: true as const,
      head,
      inspect: () => ({
        ...policy,
        projects: [...policy.projects],
        sessions: policy.sessions.map((row) => ({ ...row })),
      }),
    });
    policies.set(evidence, { policy, ledger: input.ledger });
    return evidence;
  });
}
/** Execution decision at the supplied current verified endpoint; no network/cache/clock or task cancellation. */
export type MachineExecutionDecision =
  | { readonly allowed: true; readonly reason: 'owner' | 'team' }
  | {
      readonly allowed: false;
      readonly reason:
        | 'ledger-unverified'
        | 'requester-ineligible'
        | 'target-ineligible'
        | 'target-generation-mismatch'
        | 'policy-unavailable'
        | 'policy-unverified'
        | 'policy-ledger-conflict'
        | 'policy-binding-mismatch'
        | 'policy-signer-ineligible'
        | 'machine-not-shared'
        | 'project-not-shared'
        | 'invalid-project';
    };
/** Pure execution gate. All current/future qualified members may use explicitly shared machines/projects.
 * Recovery/Guest never execute; same-owner execution needs no sharing policy. Each later action must call again
 * with the newest verified policy/ledger. Host freshness, actual project resolution and durable-start deduplication remain mandatory. */
export function authorizeMachineExecution(input: {
  readonly machineGeneration: VerifiedMachineSharingGeneration;
  readonly ledger: LedgerView;
  readonly policy: VerifiedMachineSharingPolicy | null;
  readonly signer: Bytes.SigningPublicKey;
  readonly localProjectId?: string;
  readonly target: {
    readonly workspaceId: string;
    readonly genesisHash: string;
    readonly machineId: string;
    readonly generation: string;
    readonly device: Bytes.SigningPublicKey;
  };
}): MachineExecutionDecision {
  const deny = (
    reason: Extract<MachineExecutionDecision, { allowed: false }>['reason']
  ): MachineExecutionDecision => ({ allowed: false, reason });
  const permissions = contentPermissions(input.ledger, input.signer);
  if (Result.isFailure(permissions)) return deny('ledger-unverified');
  if (!permissions.success.mayWriteDocument) return deny('requester-ineligible');
  const state = input.ledger.inspectState(),
    target = input.target;
  const machine = state.devices.get(keyId(target.device.toBytes()));
  const targetPermissions = contentPermissions(input.ledger, target.device);
  if (
    target.genesisHash !== keyId(input.ledger.genesis.toBytes()) ||
    !machine ||
    machine.kind !== 'machine' ||
    machine.machineId !== target.machineId ||
    Result.isFailure(identity(target.workspaceId)) ||
    Result.isFailure(targetPermissions) ||
    !targetPermissions.success.mayWriteDocument
  )
    return deny('target-ineligible');
  if (input.localProjectId !== undefined && Result.isFailure(identity(input.localProjectId)))
    return deny('invalid-project');
  if (
    Result.isFailure(
      requireMachineSharingGeneration(
        input.ledger,
        { ...target, ownerMembershipId: keyId(machine.membershipId.toBytes()) },
        input.machineGeneration
      )
    )
  )
    return deny('target-generation-mismatch');
  const requester = state.devices.get(keyId(input.signer.toBytes()))!;
  if (requester.membershipId.equals(machine.membershipId))
    return { allowed: true, reason: 'owner' };
  if (!input.policy) return deny('policy-unavailable');
  const evidence = policies.get(input.policy);
  if (!evidence) return deny('policy-unverified');
  if (Result.isFailure(requireLedgerContinuation(evidence.ledger, input.ledger)))
    return deny('policy-ledger-conflict');
  const policy = evidence.policy;
  if (!sameBinding(policy, { ...target, ownerMembershipId: keyId(machine.membershipId.toBytes()) }))
    return deny('policy-binding-mismatch');
  if (Result.isFailure(policyAuthority(input.ledger, policy, input.machineGeneration)))
    return deny('policy-signer-ineligible');
  if (!policy.sharedWithTeam) return deny('machine-not-shared');
  if (input.localProjectId !== undefined && !policy.projects.includes(input.localProjectId))
    return deny('project-not-shared');
  return { allowed: true, reason: 'team' };
}
