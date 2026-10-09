import { centralMailboxHttpLayer } from './key-mailbox';
import { nodeDistributionStoreLayer } from '@lody/e2ee-core/effect/platform-node';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import type { Flock } from '@loro-dev/flock-wasm';
import { StreamsClient } from '@loro-dev/streams-client';
import { Ledger, LedgerError } from '@lody/e2ee-core';
import {
  Bytes,
  ContextMismatch,
  LedgerClient as IntentLedgerClient,
  LedgerTransport,
  TransportError,
  ValidationError,
  prepareDeviceAdmission,
  prepareJoinRequest,
} from '@lody/e2ee-core/effect';
import { deviceSignerLayer, signatureVerifierLayer } from '@lody/e2ee-core/effect/platform';
import { EpochKeyringStorage, nodeJournalStoreLayer } from '@lody/e2ee-core/effect/platform-node';
import { Effect, Result, Layer } from 'effect';
import {
  commitEpochKey,
  decodeRecord,
  hashRecord,
  LedgerClient,
  recoverLedgerHistory,
  SigningPointCache,
  type ComparisonNote,
  type JoinRequest,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';
import { maySealNewContent } from '@lody/e2ee-core/streams-content';
import { StreamsLedgerStream } from '@lody/e2ee-core/streams';
import { liveEntropy, type Entropy } from '@lody/e2ee-core';
import { refMayWriteDocument, refStateFromOrg } from '../reference-model';
import { fromHex, toHex } from './bytes';
import { type DemoDevice, deviceHex, generateDevice, possessionProof } from './device';
import {
  CONTROL_STREAM,
  DEVICE_HEADER,
  KEYS_STREAM,
  type ComparisonWire,
  type IssuedCredential,
  type JoinRequestWire,
} from './protocol';
import { makeLabClock } from '../services/clock';
import type { ContentAuthority } from './content-session';
import { makeLiveFs, type LabFsShape } from '../services/fs';
import type { LabFetch } from '../services/http';
import { LabRun } from '../services/run';
import { rotationLayer } from './rotation-layer';
import {
  SessionLedger,
  executeSessionOperation,
  readSessionLedger,
  resumeSessionLedger,
} from '../workflows/session-ledger';
import { receiveKeyLayer, sendKeyLayer } from './key-delivery-layer';

export interface SessionOptions {
  readonly baseUrl: string;
  readonly clientDir: string;
  readonly account: string;
  readonly now?: () => number;
  readonly testMode?: boolean;
  readonly device?: DemoDevice;
  /** Test/lab only. Production clients omit this and use live entropy. */
  readonly entropy?: Entropy;
  /** Test/lab fetch hook. Defaults to Live LabHttp. */
  readonly fetch?: LabFetch;
  /** Injectable filesystem; defaults to Live LabFs. */
  readonly fs?: LabFsShape;
  readonly runtime?: import('../runtime').LabRuntime;
}

function wireNote(note: ComparisonNote): ComparisonWire {
  return {
    genesis: toHex(note.genesis),
    length: note.length,
    head: toHex(note.head),
    stateDigest: toHex(note.stateDigest),
    noteSigner: toHex(note.noteSigner),
  };
}

function parseNote(wire: ComparisonWire): ComparisonNote {
  return {
    genesis: fromHex(wire.genesis),
    length: wire.length,
    head: fromHex(wire.head),
    stateDigest: fromHex(wire.stateDigest),
    noteSigner: fromHex(wire.noteSigner),
  };
}

function signerLayer(device: DemoDevice) {
  return Effect.map(Effect.fromResult(Bytes.signingPublicKey(device.publicKey)), (key) =>
    deviceSignerLayer(key, (bytes) => device.sign(bytes))
  );
}

function enrollmentLayer(device: DemoDevice) {
  return Effect.map(signerLayer(device), (signing) => Layer.merge(signing, signatureVerifierLayer));
}

/** Matches StreamsLedgerStream. Create only needs the offset, not network. */
const genesisTransportLayer = Layer.succeed(LedgerTransport, {
  initialOffset: '-1',
  readAfter: () => Effect.fail(new TransportError({ operation: 'read' })),
  appendCas: () => Effect.succeed('accepted' as const),
});

function joinHelperStatus(error: unknown): string {
  if (error instanceof LedgerError) {
    if (
      error.code === 'unauthorized' ||
      error.code === 'replay' ||
      error.code === 'bad-signature' ||
      error.code === 'bad-proof'
    ) {
      return 'rejected';
    }
    if (error.code === 'invalid-operation' || error.code === 'wrong-parent') return 'conflict';
  }
  return 'unknown';
}

export class DemoSession {
  readonly account: string;
  readonly clientDir: string;
  device!: DemoDevice;
  credential: IssuedCredential | null = null;
  genesis: Uint8Array | null = null;
  genesisHex: string | null = null;
  epochKeys = new Map<number, Uint8Array>();
  userId: Uint8Array | null = null;
  private verifiedLedger: Ledger | null = null;
  membershipId: Uint8Array | null = null;
  readonly baseUrl: string;
  readonly now: () => number;
  readonly testMode: boolean;
  canWriteDocument = false;
  /** Independent reference-model write right from the last authenticated ledger. */
  authenticatedWriterMayWrite: boolean | undefined;
  /** Last authenticated ledger epoch. Content seal must use this, not max(local keys). */
  ledgerEpoch = 0;
  loroDoc: LoroDoc | null = null;
  flockDoc: Flock | null = null;
  crashAt?: 'after-import' | 'after-document' | 'before-cursor' | 'after-cursor';
  crashMarker?: string;
  readonly runtime?: import('../runtime').LabRuntime;
  readonly fs: LabFsShape;
  private ledgerClient: LedgerClient | null = null;
  // Per-session verification cache: no mutable cache state shared across runs.
  private readonly pointCache = new SigningPointCache();
  private closed = false;
  private readonly run = new LabRun(Layer.empty);
  private disposal?: Promise<void>;
  private readonly disk: LabFsShape;
  private readonly fetchImpl: LabFetch;

  constructor(private readonly options: SessionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.clientDir = options.clientDir;
    this.account = options.account;
    this.now = options.now ?? makeLabClock(() => Date.now()).nowMs;
    this.testMode = options.testMode === true;
    this.runtime = options.runtime;
    this.disk = options.fs ?? makeLiveFs();
    this.fs = this.disk;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.credential) headers.set('authorization', `Bearer ${this.credential.token}`);
    if (this.device) headers.set(DEVICE_HEADER, deviceHex(this.device));
    return headers;
  }

  random(label: string, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    (this.options.entropy ?? liveEntropy).fill(label, bytes);
    return bytes;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if (this.closed) throw new Error('session-closed');
    const target =
      typeof input === 'string' && !input.startsWith('http://') && !input.startsWith('https://')
        ? `${this.baseUrl}${input}`
        : input;
    const request = new Request(target, init);
    const headers = this.headers(request.headers);
    const upstream = this.fetchImpl;
    return upstream(new Request(request, { headers }));
  }

  private persistEpochs(keys: ReadonlyMap<number, Uint8Array> = this.epochKeys): void {
    const rows = [...keys.entries()].map(([epoch, key]) => [epoch, toHex(key)]);
    this.disk.writeText(join(this.clientDir, 'epochs.json'), `${JSON.stringify(rows)}\n`);
  }

  private ensureKeyring(): void {
    const path = join(this.clientDir, 'epochs.json');
    if (!this.disk.exists(path)) this.disk.writeText(path, '[]\n');
  }

  private epochFiles() {
    return {
      candidatePath: join(this.clientDir, 'epoch-candidate.json'),
      keyringPath: join(this.clientDir, 'epochs.json'),
      outboxPath: join(this.clientDir, 'key-outbox.sqlite'),
    };
  }

  private loadEpochs(): void {
    const path = join(this.clientDir, 'epochs.json');
    if (!this.disk.exists(path)) {
      this.epochKeys = new Map();
      return;
    }
    this.epochKeys = Result.getOrThrowWith(
      EpochKeyringStorage.decodeEpochKeyring(this.disk.readText(path)),
      (error) => error
    );
  }

  close(): Promise<void> {
    this.closed = true;
    this.ledgerClient = null;
    this.loroDoc?.free();
    this.loroDoc = null;
    this.flockDoc = null;
    return (this.disposal ??= this.run.close());
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('session-closed');
    this.disk.mkdir(this.clientDir);
    this.device = this.options.device ?? (await generateDevice());
    this.loadEpochs();
    this.credential = await this.requestCredential(null);
  }

  private async requestCredential(genesisHex: string | null): Promise<IssuedCredential> {
    const device = this.device;
    if (!device) throw new Error('not-started');
    const challenge = await this.fetch('/v1/credentials/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: this.account, deviceHex: deviceHex(device) }),
    });
    if (!challenge.ok) throw new Error(`credential-${challenge.status}`);
    const { nonce } = (await challenge.json()) as { nonce: string };
    const signature = await possessionProof(this.account, device, nonce);
    const response = await this.fetch('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: this.account,
        deviceHex: deviceHex(device),
        nonce,
        signature: toHex(signature),
        ...(genesisHex === null ? {} : { genesisHex }),
      }),
    });
    if (!response.ok) throw new Error(`credential-${response.status}`);
    return (await response.json()) as IssuedCredential;
  }

  async reauth(): Promise<void> {
    if (!this.device) throw new Error('not-started');
    this.ledgerClient = null;
    this.credential = await this.requestCredential(this.genesisHex);
  }

  private streamUrl(name: string, genesisHex = this.genesisHex): string {
    if (!genesisHex) throw new Error('no-space');
    return `${this.baseUrl}/ds/${encodeURIComponent(genesisHex)}/${name}`;
  }

  private openLedgerEffect() {
    return Effect.suspend(() => {
      if (this.closed) return Effect.fail(new Error('session-closed'));
      if (this.ledgerClient) return Effect.succeed(this.ledgerClient);
      if (!this.genesis) return Effect.fail(new Error('no-space'));
      const store = new SqliteLedgerStore(join(this.clientDir, 'ledger.sqlite'));
      const stream = new StreamsLedgerStream(
        new StreamsClient({
          url: this.streamUrl(CONTROL_STREAM),
          fetch: (input, init) => this.fetch(input, init),
          retry: { maxAttempts: 0 },
        })
      );
      return LedgerClient.openEffect(this.genesis, store, stream, this.pointCache).pipe(
        Effect.tap((client) =>
          Effect.sync(() => {
            this.ledgerClient = client;
          })
        )
      );
    });
  }

  private ledgerLayer() {
    return Layer.succeed(SessionLedger, { open: this.openLedgerEffect() });
  }

  private openLedger(): Promise<LedgerClient> {
    return this.run.run(this.openLedgerEffect());
  }

  async prepareWrite(): Promise<void> {
    const ledger = await this.readLedger();
    // A removed member or revoked device still holds this key; wait for publishEpoch.
    if (ledger.state.epoch.rotationRequired) throw new Error('rotation-required');
    const { number, keyCommitment } = ledger.state.epoch;
    const key = this.epochKeys.get(number);
    if (!key) return;
    // Seal only with the key the ledger committed for this epoch.
    const commitment = await commitEpochKey(ledger.state.genesis, number, key);
    if (toHex(commitment) !== toHex(keyCommitment)) throw new ContextMismatch({ context: 'epoch' });
  }

  async prepareRead(): Promise<void> {
    await this.readLedger();
  }

  contentAuthority(): ContentAuthority | null {
    const ledger = this.verifiedLedger;
    if (!ledger) return null;
    return {
      state: ledger.state,
      wasDeviceAdmitted: (deviceIdHex) => ledger.wasDeviceAdmitted(deviceIdHex),
    };
  }

  async readLedger(): Promise<Ledger> {
    const ledger = await this.run.run(readSessionLedger.pipe(Effect.provide(this.ledgerLayer())));
    this.verifiedLedger = ledger;
    this.ledgerEpoch = ledger.state.epoch.number;
    this.canWriteDocument = maySealNewContent(ledger.state, deviceHex(this.device));
    if (this.genesisHex) {
      this.authenticatedWriterMayWrite = refMayWriteDocument(
        refStateFromOrg(this.genesisHex, ledger.state),
        deviceHex(this.device),
        this.genesisHex,
        ledger.state.epoch.number
      );
    }
    return ledger;
  }

  /** Persist the epoch-0 secret, then let LedgerClient.create sign genesis into the journal.
   * Remote space creation stays application-owned and happens after local durability. */
  async createSpace(): Promise<{ genesisHex: string }> {
    if (!this.device || !this.credential) throw new Error('not-started');
    const secret = this.random('epoch-secret', 32);
    const userId = this.random('user-id', 32);
    const membershipId = this.random('membership-id', 16);
    this.userId = userId;
    this.membershipId = membershipId;
    const keys = new Map<number, Uint8Array>([[0, secret]]);
    this.persistEpochs(keys);
    this.epochKeys = keys;
    const commitment = await commitEpochKey(new Uint8Array(32), 0, secret);
    const journalPath = join(this.clientDir, 'ledger.sqlite');
    const encryptionKey = this.device.enc;
    const device = this.device;
    await this.run.run(
      Effect.gen(function* () {
        const signing = yield* signerLayer(device);
        yield* IntentLedgerClient.create({
          userId: yield* Effect.fromResult(Bytes.userId(userId)),
          membershipId: yield* Effect.fromResult(Bytes.membershipId(membershipId)),
          encryptionPublicKey: yield* Effect.fromResult(Bytes.encryptionPublicKey(encryptionKey)),
          epochCommitment: yield* Effect.fromResult(Bytes.epochCommitment(commitment)),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              signing,
              signatureVerifierLayer,
              nodeJournalStoreLayer({ path: journalPath, mode: 'create' }),
              genesisTransportLayer
            )
          )
        );
      }).pipe(Effect.provide(Layer.empty))
    );
    const store = new SqliteLedgerStore(journalPath, {
      createFile: false,
      initializeSchema: false,
    });
    const journal = await this.run.run(store.exclusive((tx) => tx.load));
    const genesisRecord = journal?.records[0];
    if (!journal || !genesisRecord) throw new Error('missing-genesis');
    this.genesis = new Uint8Array(genesisRecord);
    this.genesisHex = toHex(journal.genesis);
    const response = await this.fetch('/v1/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genesis: toHex(this.genesis) }),
    });
    if (!response.ok) throw new Error(`create-space-${response.status}:${await response.text()}`);
    this.ledgerClient = null;
    this.ledgerEpoch = 0;
    this.canWriteDocument = true;
    this.authenticatedWriterMayWrite = true;
    return { genesisHex: this.genesisHex };
  }

  async adoptGenesis(genesisHex: string): Promise<void> {
    const response = await this.fetch(`/v1/spaces/${genesisHex}/genesis`);
    if (!response.ok) throw new Error(`genesis-${response.status}`);
    const payload = (await response.json()) as { genesis: string };
    const genesis = fromHex(payload.genesis);
    const bound = toHex(await hashRecord(genesis));
    if (bound !== genesisHex) throw new Error('genesis-binding-mismatch');
    this.genesis = genesis;
    this.genesisHex = genesisHex;
    this.ledgerClient = null;
    this.ledgerEpoch = 0;
    this.ensureKeyring();
    this.loadEpochs();
  }

  /** Promise SDK boundary. Intent execute owns parent, signing and CAS. */
  async submit(operation: Operation): Promise<{ status: string; ledger: Ledger }> {
    if (!this.device) throw new Error('not-started');
    try {
      const result = await this.run.run(
        Effect.gen({ self: this }, function* () {
          const signing = yield* signerLayer(this.device);
          return yield* executeSessionOperation(operation).pipe(
            Effect.provide(Layer.merge(signing, this.ledgerLayer()))
          );
        })
      );
      return { status: result.status, ledger: result.ledger };
    } catch (error) {
      if (error instanceof ValidationError) throw new LedgerError(error.code, error.position);
      throw error;
    }
  }

  async resume(): Promise<{ status: string; ledger: Ledger }> {
    const result = await this.run.run(resumeSessionLedger.pipe(Effect.provide(this.ledgerLayer())));
    return { status: result.status, ledger: result.ledger };
  }

  async requestJoin(genesisHex: string): Promise<JoinRequestWire> {
    if (!this.device) throw new Error('not-started');
    await this.adoptGenesis(genesisHex);
    const userId = this.random('join-user-id', 32);
    const requestId = this.random('join-request-id', 16);
    this.userId = userId;
    const encryptionKey = this.device.enc;
    const device = this.device;
    const prepared = await this.run.run(
      Effect.gen(function* () {
        const layer = yield* enrollmentLayer(device);
        return yield* prepareJoinRequest({
          genesis: yield* Effect.fromResult(Bytes.genesisHash(fromHex(genesisHex))),
          requestId: yield* Effect.fromResult(Bytes.requestId(requestId)),
          userId: yield* Effect.fromResult(Bytes.userId(userId)),
          encryptionPublicKey: yield* Effect.fromResult(Bytes.encryptionPublicKey(encryptionKey)),
          expiresAt: null,
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.empty))
    );
    const wire: JoinRequestWire = {
      requestId: toHex(prepared.requestId.toBytes()),
      userId: toHex(prepared.userId.toBytes()),
      signingPublicKey: toHex(prepared.signingPublicKey.toBytes()),
      encryptionPublicKey: toHex(prepared.encryptionPublicKey.toBytes()),
      expiresAt: prepared.expiresAt,
      signature: toHex(prepared.signature.toBytes()),
    };
    const response = await this.fetch(`/v1/spaces/${genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    if (!response.ok) throw new Error(`join-${response.status}`);
    return wire;
  }

  async listJoins(): Promise<JoinRequestWire[]> {
    if (!this.genesisHex) throw new Error('no-space');
    const response = await this.fetch(`/v1/spaces/${this.genesisHex}/joins`);
    if (!response.ok) throw new Error(`joins-${response.status}`);
    return ((await response.json()) as { requests: JoinRequestWire[] }).requests;
  }

  async approveJoin(
    wire: JoinRequestWire,
    role: 'admin' | 'member' | 'guest' = 'member',
    options?: { membershipId?: Uint8Array }
  ): Promise<{
    status: string;
    membershipId: Uint8Array;
    admitted: boolean;
    roleConfigured: boolean;
    requestedRole: 'admin' | 'member' | 'guest';
    roleStatus?: string;
  }> {
    const request: JoinRequest = {
      requestId: fromHex(wire.requestId),
      userId: fromHex(wire.userId),
      signingPublicKey: fromHex(wire.signingPublicKey),
      encryptionPublicKey: fromHex(wire.encryptionPublicKey),
      expiresAt: wire.expiresAt,
      signature: fromHex(wire.signature),
    };
    const signingHex = toHex(request.signingPublicKey);
    const result = (
      status: string,
      membershipId: Uint8Array,
      admitted: boolean,
      roleConfigured: boolean,
      roleStatus?: string
    ) => ({
      status,
      membershipId,
      admitted,
      roleConfigured,
      requestedRole: role,
      ...(roleStatus === undefined ? {} : { roleStatus }),
    });
    const findMember = (ledger: Ledger) => {
      const device = ledger.state.devices.get(signingHex);
      if (!device) return null;
      const member = ledger.state.members.get(toHex(device.membershipId));
      return { membershipId: device.membershipId, role: member?.role };
    };
    const membershipHint = () => options?.membershipId ?? this.random('approve-membership-id', 16);

    let ledger: Ledger;
    try {
      const resumed = await this.resume();
      ledger = resumed.ledger;
      const found = findMember(ledger);
      if (resumed.status === 'unknown') {
        return result(
          'unknown',
          found?.membershipId ?? membershipHint(),
          found !== null,
          found?.role === role || (found !== null && role === 'member'),
          'unknown'
        );
      }
      if (found && (role === 'member' || found.role === role)) {
        return result('committed', found.membershipId, true, true, resumed.status);
      }
      if (found && role !== 'member') {
        return this.configureJoinRole(found.membershipId, role);
      }
      if (resumed.status !== 'committed') {
        return result(
          resumed.status,
          found?.membershipId ?? membershipHint(),
          found !== null,
          false
        );
      }
    } catch (error) {
      if (!(error instanceof LedgerError) || error.code !== 'invalid-operation') {
        try {
          ledger = await this.readLedger();
        } catch {
          return result('unknown', membershipHint(), false, false);
        }
        const found = findMember(ledger);
        return result('unknown', found?.membershipId ?? membershipHint(), found !== null, false);
      }
    }

    ledger = await this.readLedger();
    const existing = findMember(ledger);
    if (existing) {
      if (role === 'member' || existing.role === role) {
        return result('committed', existing.membershipId, true, true);
      }
      return this.configureJoinRole(existing.membershipId, role);
    }

    const membershipId = membershipHint();
    let submitted: { status: string; ledger: Ledger };
    try {
      submitted = await this.submit({ type: 'admitMember', membershipId, request });
    } catch (error) {
      const status = joinHelperStatus(error);
      return result(status, membershipId, false, false);
    }
    const admittedNow = findMember(submitted.ledger);
    if (submitted.status !== 'committed' && !admittedNow) {
      return result(submitted.status, membershipId, false, false);
    }
    const mid = admittedNow?.membershipId ?? membershipId;
    if (role === 'member' || admittedNow?.role === role) {
      return result(
        submitted.status === 'committed' ? 'committed' : submitted.status,
        mid,
        true,
        true
      );
    }
    return this.configureJoinRole(mid, role);
  }

  private async configureJoinRole(
    membershipId: Uint8Array,
    role: 'admin' | 'guest'
  ): Promise<{
    status: string;
    membershipId: Uint8Array;
    admitted: boolean;
    roleConfigured: boolean;
    requestedRole: 'admin' | 'member' | 'guest';
    roleStatus?: string;
  }> {
    try {
      const roleResult = await this.submit({ type: 'setRole', membershipId, role });
      return {
        status: roleResult.status,
        membershipId,
        admitted: true,
        roleConfigured: roleResult.status === 'committed',
        requestedRole: role,
        roleStatus: roleResult.status,
      };
    } catch (error) {
      const status = joinHelperStatus(error);
      return {
        status,
        membershipId,
        admitted: true,
        roleConfigured: false,
        requestedRole: role,
        roleStatus: status,
      };
    }
  }

  async admitDevice(
    target: DemoDevice,
    kind: 'personal' | 'machine' | 'recovery'
  ): Promise<{ status: string }> {
    if (!this.genesis || !this.genesisHex || !this.device) throw new Error('no-space');
    const ledger = await this.readLedger();
    const actor = ledger.state.devices.get(deviceHex(this.device));
    if (!actor) throw new Error('unauthorized');
    const grant = { kind };
    const genesisHex = this.genesisHex;
    const membership = actor.membershipId;
    const encryptionKey = target.enc;
    const command = await this.run.run(
      Effect.gen(function* () {
        const layer = yield* enrollmentLayer(target);
        return yield* prepareDeviceAdmission({
          genesis: yield* Effect.fromResult(Bytes.genesisHash(fromHex(genesisHex))),
          membershipId: yield* Effect.fromResult(Bytes.membershipId(membership)),
          encryptionPublicKey: yield* Effect.fromResult(Bytes.encryptionPublicKey(encryptionKey)),
          grant,
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.empty))
    );
    const client = await this.openLedger();
    const ownerLayer = await this.run.run(signerLayer(this.device));
    try {
      const result = await this.run.run(
        client.executeEffect(command).pipe(Effect.provide(ownerLayer))
      );
      return { status: result.status };
    } catch (error) {
      if (error instanceof ValidationError) throw new LedgerError(error.code, error.position);
      throw error;
    }
  }

  async revokeDevice(target: Uint8Array): Promise<{ status: string }> {
    return this.submit({ type: 'revokeDevice', target });
  }

  async removeMember(membershipId: Uint8Array): Promise<{ status: string }> {
    return this.submit({ type: 'removeMember', membershipId });
  }

  /** Promise SDK boundary; all rotation decisions and persistence ordering live in core. */
  async publishEpoch(): Promise<{ status: string; epoch: number }> {
    if (!this.genesis || !this.genesisHex) throw new Error('no-space');
    const client = await this.openLedger();
    const result = await this.run.run(
      Effect.gen({ self: this }, function* () {
        const genesis = yield* Effect.fromResult(Bytes.genesisHash(fromHex(this.genesisHex ?? '')));
        const layer = yield* rotationLayer({
          genesis,
          candidatePath: join(this.clientDir, 'epoch-candidate.json'),
          keyringPath: join(this.clientDir, 'epochs.json'),
          device: this.device,
          entropy: this.options.entropy ?? liveEntropy,
          fs: this.options.fs,
        });
        return yield* client.rotateEpochEffect().pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.empty))
    );
    this.loadEpochs();
    this.ledgerEpoch = result.ledger.inspectState().epoch.number;
    const status = {
      Committed: 'committed',
      Conflict: 'conflict',
      Pending: 'unknown',
      Unsupported: 'unsupported',
      Idle: 'idle',
    }[result._tag];
    return { status, epoch: 'epoch' in result ? result.epoch : this.ledgerEpoch };
  }

  /** Promise SDK boundary. Observed ciphertext is not recipient installation. */
  async deliverEpochKey(recipient: DemoDevice, epoch = this.currentEpoch()): Promise<Uint8Array> {
    if (!this.device || !this.genesis || !this.genesisHex) throw new Error('no-space');
    await this.readLedger();
    if (epoch !== this.currentEpoch()) throw new ContextMismatch({ context: 'epoch' });
    this.ensureKeyring();
    const client = await this.openLedger();
    const files = this.epochFiles();
    const result = await this.run.run(
      Effect.gen({ self: this }, function* () {
        const genesis = yield* Effect.fromResult(Bytes.genesisHash(fromHex(this.genesisHex ?? '')));
        const recipientKey = yield* Effect.fromResult(Bytes.signingPublicKey(recipient.publicKey));
        const layer = yield* sendKeyLayer({
          genesis,
          candidatePath: files.candidatePath,
          keyringPath: files.keyringPath,
          outboxPath: files.outboxPath,
          outboxMode: this.disk.exists(files.outboxPath) ? 'open' : 'create',
          device: this.device,
          entropy: this.options.entropy ?? liveEntropy,
          streams: new StreamsClient({
            url: this.streamUrl(KEYS_STREAM),
            fetch: (input, init) => this.fetch(input, init),
            retry: { maxAttempts: 0 },
          }),
          fs: this.options.fs,
        });
        return yield* client.sendCurrentEpochKeyEffect(recipientKey).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.empty))
    );
    if (result._tag !== 'Observed') throw new Error('pending-key-delivery');
    return result.frame;
  }

  currentEpoch(): number {
    return this.ledgerEpoch;
  }

  /** Promise SDK boundary. Success means durable install after verification. */
  async receiveEpochKey(sender: DemoDevice, epoch: number, frame: Uint8Array): Promise<void> {
    if (!this.device || !this.genesis || !this.genesisHex) throw new Error('no-space');
    await this.readLedger();
    if (epoch !== this.currentEpoch()) throw new ContextMismatch({ context: 'epoch' });
    this.ensureKeyring();
    const client = await this.openLedger();
    const files = this.epochFiles();
    await this.run.run(
      Effect.gen({ self: this }, function* () {
        const genesis = yield* Effect.fromResult(Bytes.genesisHash(fromHex(this.genesisHex ?? '')));
        const senderKey = yield* Effect.fromResult(Bytes.signingPublicKey(sender.publicKey));
        const layer = yield* receiveKeyLayer({
          genesis,
          candidatePath: files.candidatePath,
          keyringPath: files.keyringPath,
          device: this.device,
          fs: this.options.fs,
        });
        return yield* client.receiveEpochKeyEffect(senderKey, frame).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.empty))
    );
    this.loadEpochs();
  }

  /** Explicit bounded application event hook for startup, verified ledger changes and reconnect.
   * Legacy scripted sends still use the old keys stream. This opt-in path uses mailbox SQLite. */
  async centralKeyRound(limit = 100) {
    if (!this.device || !this.genesisHex) throw new Error('no-space');
    if (this.credential?.genesisHex !== this.genesisHex) await this.reauth();
    await this.readLedger();
    this.ensureKeyring();
    const client = await this.openLedger();
    const files = this.epochFiles();
    const distributionPath = join(this.clientDir, 'key-distribution.sqlite');
    const outcome = await this.run.run(
      Effect.gen({ self: this }, function* () {
        const genesis = yield* Effect.fromResult(Bytes.genesisHash(fromHex(this.genesisHex!)));
        const sender = yield* sendKeyLayer({
          genesis,
          candidatePath: files.candidatePath,
          keyringPath: files.keyringPath,
          outboxPath: files.outboxPath,
          outboxMode: this.disk.exists(files.outboxPath) ? 'open' : 'create',
          device: this.device,
          entropy: this.options.entropy ?? liveEntropy,
          streams: new StreamsClient({
            url: this.streamUrl(KEYS_STREAM),
            fetch: (i, n) => this.fetch(i, n),
            retry: { maxAttempts: 0 },
          }),
          fs: this.options.fs,
        });
        const receiver = yield* receiveKeyLayer({
          genesis,
          candidatePath: files.candidatePath,
          keyringPath: files.keyringPath,
          device: this.device,
          fs: this.options.fs,
        });
        const mailbox = centralMailboxHttpLayer({
          url: `${this.baseUrl}/v1/spaces/${this.genesisHex}/key-mailbox`,
          fetch: (i, n) => this.fetch(i, n),
        });
        return yield* Effect.gen(function* () {
          const distribution = yield* client.keyDistributionEffect();
          yield* distribution.flushRepairs(limit);
          yield* distribution.resumeReceives(limit);
          const received = yield* distribution.fetchAndInstall(null, limit);
          yield* distribution.flushInstallationReports(limit);
          const scheduled = yield* distribution.reconcileCurrentEpoch();
          yield* distribution.resumePendingDeliveries(limit);
          yield* distribution.flushInstallationReports(limit);
          return {
            scheduled: scheduled.scheduled,
            received: received.processed,
            next: received.next,
            results: yield* distribution.readUnacknowledgedResults(null, limit),
          };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              sender,
              receiver,
              nodeDistributionStoreLayer({
                path: distributionPath,
                mode: this.disk.exists(distributionPath) ? 'open' : 'create',
              }),
              mailbox
            )
          )
        );
      })
    );
    this.loadEpochs();
    return outcome;
  }

  async recoverEpochHistory(): Promise<Map<number, Uint8Array>> {
    if (!this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const latest = this.epochKeys.get(ledger.state.epoch.number);
    if (!latest) throw new Error('missing-epoch-key');
    // History packets come from the verified ledger, never raw stream bytes.
    const recovered = await recoverLedgerHistory(ledger, latest);
    const merged = new Map(this.epochKeys);
    for (const [epoch, key] of recovered) {
      const held = merged.get(epoch);
      // Installed keys are append-only; a different key is corruption, not an update.
      if (held && toHex(held) !== toHex(key)) throw new ContextMismatch({ context: 'epoch' });
      merged.set(epoch, key);
    }
    this.persistEpochs(merged);
    this.epochKeys = merged;
    return recovered;
  }

  async exportNote(): Promise<ComparisonWire> {
    const ledger = await this.readLedger();
    return wireNote(ledger.comparisonNote(this.device.publicKey));
  }

  async publishNote(): Promise<ComparisonWire> {
    const note = await this.exportNote();
    const response = await this.fetch(`/v1/spaces/${this.genesisHex}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(note),
    });
    if (!response.ok) throw new Error(`note-${response.status}`);
    return note;
  }

  async compareRemote(): Promise<{ kind: string; independent?: boolean; source: 'server' }> {
    if (!this.genesisHex || !this.device) throw new Error('no-space');
    const ledger = await this.readLedger();
    const local = ledger.comparisonNote(this.device.publicKey);
    const response = await this.fetch(`/v1/spaces/${this.genesisHex}/notes`);
    if (!response.ok) throw new Error(`notes-${response.status}`);
    const payload = (await response.json()) as {
      notes: Array<{ deviceHex: string; body: string }>;
    };
    const other = payload.notes.find((row) => row.deviceHex !== deviceHex(this.device));
    if (!other) return { kind: 'pending-sync', source: 'server' };
    return {
      ...this.finishCompare(local, parseNote(JSON.parse(other.body) as ComparisonWire), false),
      source: 'server',
    };
  }

  async compareIndependent(
    remote: ComparisonWire
  ): Promise<{ kind: string; independent?: boolean; source: 'independent' }> {
    const ledger = await this.readLedger();
    const local = ledger.comparisonNote(this.device.publicKey);
    return { ...this.finishCompare(local, parseNote(remote), true), source: 'independent' };
  }

  private finishCompare(local: ComparisonNote, remote: ComparisonNote, channelConfirmed: boolean) {
    if (!this.genesis) throw new Error('no-space');
    const decoded = decodeRecord(this.genesis);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    return Ledger.compareNotes(local, remote, {
      originalEndorser: decoded.body.fields.signer,
      confirmedNoteSigners: channelConfirmed ? [remote.noteSigner] : [],
    });
  }

  async readKeyFrames(): Promise<Uint8Array[]> {
    const client = new StreamsClient({
      url: this.streamUrl(KEYS_STREAM),
      fetch: (input, init) => this.fetch(input, init),
      retry: { maxAttempts: 0 },
    });
    const frames: Uint8Array[] = [];
    let offset = '-1';
    for (let page = 0; page < 64; page++) {
      const response = await client.read({ offset });
      if (!response.ok) break;
      const body = new Uint8Array(response.result.payload.body);
      if (body.byteLength > 0) frames.push(body);
      offset = response.result.nextOffset;
      if (response.result.upToDate) break;
    }
    return frames;
  }
}

export { generateDevice, deviceHex, possessionProof };
