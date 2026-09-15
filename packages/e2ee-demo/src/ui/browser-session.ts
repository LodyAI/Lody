import { StreamsClient } from '@loro-dev/streams-client';
import { Ledger } from '@lody/e2ee-core';
import {
  commitEpochKey,
  decodeRecord,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  joinRequestSigningBytes,
  LedgerClient,
  MemoryLedgerStore,
  signingBytesForBody,
  type ComparisonNote,
  type JoinRequest,
} from '@lody/e2ee-core/ledger';
import { StreamsLedgerStream } from '@lody/e2ee-core/streams';
import { fromHex, randomBytes, toHex } from '../bytes';
import { type DemoDevice, deviceHex, generateDevice, possessionProof } from '../device';
import {
  CONTROL_STREAM,
  DEVICE_HEADER,
  type ComparisonWire,
  type IssuedCredential,
  type JoinRequestWire,
} from '../protocol';

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

export class BrowserSession {
  device!: DemoDevice;
  credential: IssuedCredential | null = null;
  genesis: Uint8Array | null = null;
  genesisHex: string | null = null;
  length = 0;
  compareKind = '';
  private ledgerClient: LedgerClient | null = null;
  private readonly store = new MemoryLedgerStore();

  constructor(
    readonly baseUrl: string,
    readonly account: string
  ) {}

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.credential) headers.set('authorization', `Bearer ${this.credential.token}`);
    if (this.device) headers.set(DEVICE_HEADER, deviceHex(this.device));
    return headers;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    return fetch(url, { ...init, headers: this.headers(init.headers) });
  }

  async start(): Promise<void> {
    this.device = await generateDevice();
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

  private async openLedger(): Promise<LedgerClient> {
    if (this.ledgerClient) return this.ledgerClient;
    if (!this.genesis || !this.genesisHex) throw new Error('no-space');
    const stream = new StreamsLedgerStream(
      new StreamsClient({
        url: `${this.baseUrl}/ds/${encodeURIComponent(this.genesisHex)}/${CONTROL_STREAM}`,
        fetch: (input, init) => fetch(input, { ...init, headers: this.headers(init?.headers) }),
        retry: { maxAttempts: 0 },
      })
    );
    this.ledgerClient = await LedgerClient.open(this.genesis, this.store, stream);
    return this.ledgerClient;
  }

  async readLedger(): Promise<Ledger> {
    const ledger = await (await this.openLedger()).read();
    this.length = ledger.length;
    return ledger;
  }

  async createSpace(): Promise<string> {
    if (!this.device) throw new Error('not-started');
    const secret = randomBytes(32);
    const userId = randomBytes(32);
    const membershipId = randomBytes(16);
    const body = encodeGenesisBody({
      signer: this.device.publicKey,
      userId,
      membershipId,
      encryptionPublicKey: this.device.enc,
      epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
    });
    this.genesis = encodeSignedRecord(body, await this.device.sign(signingBytesForBody(body)));
    this.genesisHex = toHex(await hashRecord(this.genesis));
    const response = await this.fetch('/v1/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genesis: toHex(this.genesis) }),
    });
    if (!response.ok) throw new Error(`create-space-${response.status}`);
    this.ledgerClient = null;
    await this.readLedger();
    return this.genesisHex;
  }

  async adoptGenesis(genesisHex: string): Promise<void> {
    const response = await this.fetch(`/v1/spaces/${genesisHex}/genesis`);
    if (!response.ok) throw new Error(`genesis-${response.status}`);
    const payload = (await response.json()) as { genesis: string };
    this.genesis = fromHex(payload.genesis);
    this.genesisHex = genesisHex;
    this.ledgerClient = null;
    await this.readLedger();
  }

  async requestJoin(genesisHex: string): Promise<void> {
    await this.adoptGenesis(genesisHex);
    const request: Omit<JoinRequest, 'signature'> = {
      requestId: randomBytes(16),
      userId: randomBytes(32),
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
      expiresAt: null,
      signature: toHex(signature),
    };
    const response = await this.fetch(`/v1/spaces/${genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    if (!response.ok) throw new Error(`join-${response.status}`);
  }

  async approveFirstJoin(): Promise<void> {
    if (!this.genesisHex || !this.device) throw new Error('no-space');
    const listed = await this.fetch(`/v1/spaces/${this.genesisHex}/joins`);
    const payload = (await listed.json()) as { requests: JoinRequestWire[] };
    const wire = payload.requests[0];
    if (!wire) throw new Error('no-join');
    const membershipId = randomBytes(16);
    const request: JoinRequest = {
      requestId: fromHex(wire.requestId),
      userId: fromHex(wire.userId),
      signingPublicKey: fromHex(wire.signingPublicKey),
      encryptionPublicKey: fromHex(wire.encryptionPublicKey),
      expiresAt: wire.expiresAt,
      signature: fromHex(wire.signature),
    };
    const client = await this.openLedger();
    const ledger = await client.read();
    const proposal = ledger.prepare(
      { type: 'admitMember', membershipId, request },
      this.device.publicKey
    );
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await this.device.sign(proposal.signingBytes)
    );
    const result = await client.submit(record);
    if (result.status !== 'committed') throw new Error(`approve-${result.status}`);
    await this.readLedger();
  }

  async publishNote(): Promise<void> {
    const ledger = await this.readLedger();
    const note = wireNote(ledger.comparisonNote(this.device.publicKey));
    const response = await this.fetch(`/v1/spaces/${this.genesisHex}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(note),
    });
    if (!response.ok) throw new Error(`note-${response.status}`);
  }

  async compare(): Promise<string> {
    if (!this.genesis || !this.device) throw new Error('no-space');
    const ledger = await this.readLedger();
    const local = ledger.comparisonNote(this.device.publicKey);
    const response = await this.fetch(`/v1/spaces/${this.genesisHex}/notes`);
    const payload = (await response.json()) as {
      notes: Array<{ deviceHex: string; body: string }>;
    };
    const other = payload.notes.find((row) => row.deviceHex !== deviceHex(this.device));
    if (!other) {
      this.compareKind = 'pending-sync';
      return this.compareKind;
    }
    const remote = parseNote(JSON.parse(other.body) as ComparisonWire);
    const decoded = decodeRecord(this.genesis);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    const comparison = Ledger.compareNotes(local, remote, {
      originalEndorser: decoded.body.fields.signer,
    });
    this.compareKind = comparison.kind;
    return comparison.kind;
  }
}

export function compareLabel(kind: string): string {
  if (kind === 'agree') return 'checked';
  if (kind === 'conflict' || kind === 'different-org') return 'inconsistent';
  if (kind === 'pending-sync') return 'pending';
  return kind || 'none';
}
