import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import type { Flock } from '@loro-dev/flock-wasm';
import { StreamsClient } from '@loro-dev/streams-client';
import { Ledger } from '@lody/e2ee-core';
import {
  collectEpochPackets,
  commitEpochKey,
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  LedgerClient,
  openEpochEnvelope,
  possessionSigningBytes,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
  signingBytesForBody,
  SigningPointCache,
  type ComparisonNote,
  type JoinRequest,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';
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
import { makeLiveFs, type LabFsShape } from '../services/fs';
import type { LabFetch } from '../services/http';

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

export class DemoSession {
  readonly account: string;
  readonly clientDir: string;
  device!: DemoDevice;
  credential: IssuedCredential | null = null;
  genesis: Uint8Array | null = null;
  genesisHex: string | null = null;
  epochKeys = new Map<number, Uint8Array>();
  userId: Uint8Array | null = null;
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
    this.disk.mkdir(this.clientDir);
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
    const target =
      typeof input === 'string' && !input.startsWith('http://') && !input.startsWith('https://')
        ? `${this.baseUrl}${input}`
        : input;
    const request = new Request(target, init);
    const headers = this.headers(request.headers);
    const upstream = this.fetchImpl;
    return upstream(new Request(request, { headers }));
  }

  private persistEpochs(): void {
    const rows = [...this.epochKeys.entries()].map(([epoch, key]) => [epoch, toHex(key)]);
    this.disk.writeText(join(this.clientDir, 'epochs.json'), `${JSON.stringify(rows)}\n`);
  }

  private loadEpochs(): void {
    const path = join(this.clientDir, 'epochs.json');
    try {
      if (!this.disk.exists(path)) {
        this.epochKeys = new Map();
        return;
      }
      const rows = JSON.parse(this.disk.readText(path)) as Array<[number, string]>;
      this.epochKeys = new Map(rows.map(([epoch, key]) => [epoch, fromHex(key)]));
    } catch {
      this.epochKeys = new Map();
    }
  }

  close(): void {
    this.closed = true;
    this.ledgerClient = null;
    this.loroDoc?.free();
    this.loroDoc = null;
    this.flockDoc = null;
  }

  async start(): Promise<void> {
    this.device = this.options.device ?? (await generateDevice());
    this.loadEpochs();
    const signature = await possessionProof(this.account, this.device);
    const response = await this.fetch('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: this.account,
        deviceHex: deviceHex(this.device),
        signature: toHex(signature),
      }),
    });
    if (!response.ok) throw new Error(`credential-${response.status}`);
    this.credential = (await response.json()) as IssuedCredential;
  }

  async reauth(): Promise<void> {
    if (!this.device) throw new Error('not-started');
    this.ledgerClient = null;
    const signature = await possessionProof(this.account, this.device);
    const response = await this.fetch('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: this.account,
        deviceHex: deviceHex(this.device),
        signature: toHex(signature),
        genesisHex: this.genesisHex,
      }),
    });
    if (!response.ok) throw new Error(`credential-${response.status}`);
    this.credential = (await response.json()) as IssuedCredential;
  }

  private streamUrl(name: string, genesisHex = this.genesisHex): string {
    if (!genesisHex) throw new Error('no-space');
    return `${this.baseUrl}/ds/${encodeURIComponent(genesisHex)}/${name}`;
  }

  private async openLedger(): Promise<LedgerClient> {
    if (this.ledgerClient) return this.ledgerClient;
    if (!this.genesis) throw new Error('no-space');
    const store = new SqliteLedgerStore(join(this.clientDir, 'ledger.sqlite'));
    const stream = new StreamsLedgerStream(
      new StreamsClient({
        url: this.streamUrl(CONTROL_STREAM),
        fetch: (input, init) => this.fetch(input, init),
        retry: { maxAttempts: 0 },
      })
    );
    this.ledgerClient = await LedgerClient.open(this.genesis, store, stream, this.pointCache);
    return this.ledgerClient;
  }

  async prepareWrite(): Promise<void> {
    await this.readLedger();
  }

  async readLedger(): Promise<Ledger> {
    const ledger = await (await this.openLedger()).read();
    this.ledgerEpoch = ledger.state.epoch.number;
    this.canWriteDocument = [...ledger.state.devices.entries()].some(([id, device]) => {
      if (id !== deviceHex(this.device)) return false;
      const member = ledger.state.members.get(toHex(device.membershipId));
      return (
        (device.kind === 'personal' || device.kind === 'machine') &&
        member !== undefined &&
        member.role !== 'guest'
      );
    });
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

  async createSpace(): Promise<{ genesisHex: string }> {
    if (!this.device || !this.credential) throw new Error('not-started');
    const secret = this.random('epoch-secret', 32);
    this.userId = this.random('user-id', 32);
    this.membershipId = this.random('membership-id', 16);
    const body = encodeGenesisBody(
      {
        signer: this.device.publicKey,
        userId: this.userId,
        membershipId: this.membershipId,
        encryptionPublicKey: this.device.enc,
        epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
      },
      this.pointCache
    );
    this.genesis = encodeSignedRecord(body, await this.device.sign(signingBytesForBody(body)));
    this.genesisHex = toHex(await hashRecord(this.genesis));
    this.epochKeys.set(0, secret);
    this.persistEpochs();
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
  }

  async submit(operation: Operation): Promise<{ status: string; ledger: Ledger }> {
    if (!this.device) throw new Error('not-started');
    const client = await this.openLedger();
    const ledger = await client.read();
    const proposal = ledger.prepare(operation, this.device.publicKey, this.pointCache);
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await this.device.sign(proposal.signingBytes)
    );
    const result = await client.submit(record);
    return { status: result.status, ledger: result.ledger };
  }

  async resume(): Promise<{ status: string; ledger: Ledger }> {
    const result = await (await this.openLedger()).resume();
    return { status: result.status, ledger: result.ledger };
  }

  async requestJoin(genesisHex: string): Promise<JoinRequestWire> {
    if (!this.device) throw new Error('not-started');
    await this.adoptGenesis(genesisHex);
    this.userId = this.random('join-user-id', 32);
    const request: Omit<JoinRequest, 'signature'> = {
      requestId: this.random('join-request-id', 16),
      userId: this.userId,
      signingPublicKey: this.device.publicKey,
      encryptionPublicKey: this.device.enc,
      expiresAt: null,
    };
    const signature = await this.device.sign(joinRequestSigningBytes(fromHex(genesisHex), request));
    const wire: JoinRequestWire = {
      requestId: toHex(request.requestId),
      userId: toHex(request.userId),
      signingPublicKey: toHex(request.signingPublicKey),
      encryptionPublicKey: toHex(request.encryptionPublicKey),
      expiresAt: request.expiresAt,
      signature: toHex(signature),
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
    role: 'admin' | 'member' | 'guest' = 'member'
  ): Promise<{
    status: string;
    membershipId: Uint8Array;
    admitted: boolean;
    roleConfigured: boolean;
    requestedRole: 'admin' | 'member' | 'guest';
    deviceCanManage: false;
    roleStatus?: string;
  }> {
    const membershipId = this.random('approve-membership-id', 16);
    const request: JoinRequest = {
      requestId: fromHex(wire.requestId),
      userId: fromHex(wire.userId),
      signingPublicKey: fromHex(wire.signingPublicKey),
      encryptionPublicKey: fromHex(wire.encryptionPublicKey),
      expiresAt: wire.expiresAt,
      signature: fromHex(wire.signature),
    };
    const submitted = await this.submit({ type: 'admitMember', membershipId, request });
    const admitted = submitted.status === 'committed';
    if (role === 'member' || !admitted) {
      return {
        status: submitted.status,
        membershipId,
        admitted,
        roleConfigured: admitted && role === 'member',
        requestedRole: role,
        deviceCanManage: false,
      };
    }
    const roleResult = await this.submit({ type: 'setRole', membershipId, role });
    const roleConfigured = roleResult.status === 'committed';
    return {
      status: roleResult.status,
      membershipId,
      admitted: true,
      roleConfigured,
      requestedRole: role,
      roleStatus: roleResult.status,
      deviceCanManage: false,
    };
  }

  async admitDevice(
    target: DemoDevice,
    kind: 'personal' | 'machine' | 'recovery',
    canManage: boolean
  ): Promise<{ status: string }> {
    if (!this.genesis || !this.genesisHex) throw new Error('no-space');
    const possessionSignature = await target.sign(
      possessionSigningBytes({
        genesis: fromHex(this.genesisHex),
        signingPublicKey: target.publicKey,
        encryptionPublicKey: target.enc,
        kind,
        canManage,
      })
    );
    return this.submit({
      type: 'admitDevice',
      kind,
      signingPublicKey: target.publicKey,
      encryptionPublicKey: target.enc,
      canManage,
      possessionSignature,
    });
  }

  async revokeDevice(target: Uint8Array): Promise<{ status: string }> {
    return this.submit({ type: 'revokeDevice', target });
  }

  async removeMember(membershipId: Uint8Array): Promise<{ status: string }> {
    return this.submit({ type: 'removeMember', membershipId });
  }

  async publishEpoch(): Promise<{ status: string; epoch: number }> {
    if (!this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const previous = this.epochKeys.get(ledger.state.epoch.number);
    if (!previous) throw new Error('missing-epoch-key');
    const next = this.random('publish-epoch-secret', 32);
    const epoch = ledger.state.epoch.number + 1;
    const packet = sealHistoryPacket(
      next,
      previous,
      this.genesis,
      epoch,
      this.options.entropy ?? liveEntropy
    );
    const submitted = await this.submit({
      type: 'publishEpoch',
      epoch,
      commitment: await commitEpochKey(this.genesis, epoch, next),
      previousEpochKey: packet,
    });
    if (submitted.status === 'committed') {
      this.epochKeys.set(epoch, next);
      this.ledgerEpoch = epoch;
      this.persistEpochs();
    }
    return { status: submitted.status, epoch };
  }

  async deliverEpochKey(recipient: DemoDevice, epoch = this.currentEpoch()): Promise<void> {
    if (!this.device || !this.genesis) throw new Error('no-space');
    const key = this.epochKeys.get(epoch);
    if (!key) throw new Error('missing-epoch-key');
    const ledger = await this.readLedger();
    const frame = await sealEpochEnvelope({
      state: ledger.state,
      genesis: this.genesis,
      epoch,
      sender: this.device.publicKey,
      recipient: recipient.publicKey,
      recipientEncryptionKey: recipient.enc,
      epochKey: key,
      sign: (bytes) => this.device.sign(bytes),
      entropy: this.options.entropy,
      cache: this.pointCache,
    });
    const client = new StreamsClient({
      url: this.streamUrl(KEYS_STREAM),
      fetch: (input, init) => this.fetch(input, init),
      retry: { maxAttempts: 0 },
    });
    const head = await client.head();
    if (!head.ok) throw new Error('keys-head');
    const result = await client.appendCas({
      expectedOffset: head.result.nextOffset,
      part: { contentType: 'application/octet-stream', body: frame },
    });
    if (!result.ok || result.result.kind !== 'ok') throw new Error('keys-cas');
  }

  currentEpoch(): number {
    return this.ledgerEpoch;
  }

  async receiveEpochKey(sender: DemoDevice, epoch: number, frame: Uint8Array): Promise<void> {
    if (!this.device || !this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const key = await openEpochEnvelope({
      state: ledger.state,
      genesis: this.genesis,
      epoch,
      sender: sender.publicKey,
      recipient: this.device.publicKey,
      recipientKeyPair: this.device.encryption,
      frame,
      cache: this.pointCache,
    });
    this.epochKeys.set(epoch, key);
    this.persistEpochs();
  }

  async recoverEpochHistory(): Promise<Map<number, Uint8Array>> {
    if (!this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const latest = this.epochKeys.get(ledger.state.epoch.number);
    if (!latest) throw new Error('missing-epoch-key');
    const decoded = decodeRecord(this.genesis);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    const records: Uint8Array[] = [this.genesis];
    // Public verify path: re-read by hashing through the client ledger.
    const recovered = await recoverHistory({
      genesis: this.genesis,
      latestEpoch: ledger.state.epoch.number,
      latestKey: latest,
      packets: collectEpochPackets(
        records.concat(await this.suffixRecords(ledger)),
        decoded.body.fields.epochCommitment
      ),
    });
    this.epochKeys = recovered;
    this.persistEpochs();
    return recovered;
  }

  private async suffixRecords(ledger: Ledger): Promise<Uint8Array[]> {
    const client = new StreamsClient({
      url: this.streamUrl(CONTROL_STREAM),
      fetch: (input, init) => this.fetch(input, init),
      retry: { maxAttempts: 0 },
    });
    const records: Uint8Array[] = [];
    let offset = '-1';
    for (let page = 0; page < 256; page++) {
      const response = await client.read({ offset });
      if (!response.ok) break;
      const body = new Uint8Array(response.result.payload.body);
      const view = new DataView(body.buffer);
      let start = 0;
      while (body.length - start >= 4) {
        const length = view.getUint32(start, false);
        records.push(body.slice(start + 4, start + 4 + length));
        start += 4 + length;
      }
      offset = response.result.nextOffset;
      if (response.result.upToDate) break;
    }
    void ledger;
    return records;
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
      ...this.finishCompare(local, parseNote(JSON.parse(other.body) as ComparisonWire)),
      source: 'server',
    };
  }

  async compareIndependent(
    remote: ComparisonWire
  ): Promise<{ kind: string; independent?: boolean; source: 'independent' }> {
    const ledger = await this.readLedger();
    const local = ledger.comparisonNote(this.device.publicKey, this.pointCache);
    return { ...this.finishCompare(local, parseNote(remote)), source: 'independent' };
  }

  private finishCompare(local: ComparisonNote, remote: ComparisonNote) {
    if (!this.genesis) throw new Error('no-space');
    const decoded = decodeRecord(this.genesis, this.pointCache);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    return Ledger.compareNotes(local, remote, {
      originalEndorser: decoded.body.fields.signer,
      pointCache: this.pointCache,
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
