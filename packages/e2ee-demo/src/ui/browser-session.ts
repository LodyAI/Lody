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
  MemoryLedgerStore,
  openEpochEnvelope,
  possessionSigningBytes,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
  signingBytesForBody,
  type ComparisonNote,
  type JoinRequest,
  type Operation,
} from '@lody/e2ee-core/ledger';
import { StreamsLedgerStream } from '@lody/e2ee-core/streams';
import { exportBackup, recoveryAsDevice, restoreBackup } from '../backup';
import { fromHex, randomBytes, toHex } from '../bytes';
import type { ContentClient } from '../content-session';
import { type DemoDevice, deviceHex, generateDevice, possessionProof } from '../device';
import {
  CONTROL_STREAM,
  DEVICE_HEADER,
  KEYS_STREAM,
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

export class BrowserSession implements ContentClient {
  device!: DemoDevice;
  credential: IssuedCredential | null = null;
  genesis: Uint8Array | null = null;
  genesisHex: string | null = null;
  length = 0;
  compareKind = '';
  epochKeys = new Map<number, Uint8Array>();
  membershipId: Uint8Array | null = null;
  userId: Uint8Array | null = null;
  canWriteDocument = false;
  epoch = 0;
  loroText = '';
  flockText = '';
  keysReceived = 0;
  private ledgerClient: LedgerClient | null = null;
  private readonly store = new MemoryLedgerStore();

  constructor(
    readonly baseUrl: string,
    readonly account: string
  ) {}

  currentEpoch(): number {
    return Math.max(0, ...this.epochKeys.keys());
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (this.credential) headers.set('authorization', `Bearer ${this.credential.token}`);
    if (this.device) headers.set(DEVICE_HEADER, deviceHex(this.device));
    return headers;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const target =
      typeof input === 'string' && !input.startsWith('http://') && !input.startsWith('https://')
        ? `${this.baseUrl}${input}`
        : input;
    const request = new Request(target, init);
    return fetch(new Request(request, { headers: this.headers(request.headers) }));
  }

  async start(): Promise<void> {
    this.device = await generateDevice();
    await this.issueCredential();
  }

  private async issueCredential(): Promise<void> {
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

  async reauth(): Promise<void> {
    this.ledgerClient = null;
    await this.issueCredential();
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
    this.epoch = ledger.state.epoch.number;
    const me = ledger.state.devices.get(deviceHex(this.device));
    if (me) this.membershipId = me.membershipId;
    this.canWriteDocument = [...ledger.state.devices.entries()].some(([id, device]) => {
      if (id !== deviceHex(this.device)) return false;
      const member = ledger.state.members.get(toHex(device.membershipId));
      return (
        (device.kind === 'personal' || device.kind === 'machine') &&
        member !== undefined &&
        member.role !== 'guest'
      );
    });
    return ledger;
  }

  async createSpace(): Promise<string> {
    if (!this.device) throw new Error('not-started');
    const secret = randomBytes(32);
    this.userId = randomBytes(32);
    this.membershipId = randomBytes(16);
    const body = encodeGenesisBody({
      signer: this.device.publicKey,
      userId: this.userId,
      membershipId: this.membershipId,
      encryptionPublicKey: this.device.enc,
      epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
    });
    this.genesis = encodeSignedRecord(body, await this.device.sign(signingBytesForBody(body)));
    this.genesisHex = toHex(await hashRecord(this.genesis));
    this.epochKeys.set(0, secret);
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
    this.userId = randomBytes(32);
    const request: Omit<JoinRequest, 'signature'> = {
      requestId: randomBytes(16),
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
    const result = await this.submit({ type: 'admitMember', membershipId, request });
    if (result.status !== 'committed') throw new Error(`approve-${result.status}`);
    await this.readLedger();
  }

  async submit(operation: Operation): Promise<{ status: string; ledger: Ledger }> {
    if (!this.device) throw new Error('not-started');
    const client = await this.openLedger();
    const ledger = await client.read();
    const proposal = ledger.prepare(operation, this.device.publicKey);
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await this.device.sign(proposal.signingBytes)
    );
    const result = await client.submit(record);
    this.length = result.ledger.length;
    return { status: result.status, ledger: result.ledger };
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
    });
    const client = new StreamsClient({
      url: `${this.baseUrl}/ds/${encodeURIComponent(this.genesisHex!)}/${KEYS_STREAM}`,
      fetch: (input, init) => fetch(input, { ...init, headers: this.headers(init?.headers) }),
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

  async deliverToOthers(): Promise<number> {
    const ledger = await this.readLedger();
    let sent = 0;
    for (const [id, device] of ledger.state.devices) {
      if (id === deviceHex(this.device)) continue;
      const recipient: DemoDevice = {
        publicKey: fromHex(id),
        enc: device.encryptionPublicKey,
        signing: this.device.signing,
        encryption: this.device.encryption,
        sign: (bytes) => this.device.sign(bytes),
      };
      await this.deliverEpochKey(recipient);
      sent += 1;
    }
    return sent;
  }

  async readKeyFrames(): Promise<Uint8Array[]> {
    const client = new StreamsClient({
      url: `${this.baseUrl}/ds/${encodeURIComponent(this.genesisHex!)}/${KEYS_STREAM}`,
      fetch: (input, init) => fetch(input, { ...init, headers: this.headers(init?.headers) }),
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

  async receivePendingKeys(): Promise<number> {
    if (!this.device || !this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const frames = await this.readKeyFrames();
    let opened = 0;
    for (const frame of frames) {
      for (const [id] of ledger.state.devices) {
        if (id === deviceHex(this.device)) continue;
        try {
          const key = await openEpochEnvelope({
            state: ledger.state,
            genesis: this.genesis,
            epoch: ledger.state.epoch.number,
            sender: fromHex(id),
            recipient: this.device.publicKey,
            recipientKeyPair: this.device.encryption,
            frame,
          });
          this.epochKeys.set(ledger.state.epoch.number, key);
          opened += 1;
        } catch {
          /* frame was for another recipient or sender */
        }
      }
    }
    this.keysReceived = this.epochKeys.size;
    return opened;
  }

  async publishEpoch(): Promise<void> {
    if (!this.genesis) throw new Error('no-space');
    const ledger = await this.readLedger();
    const previous = this.epochKeys.get(ledger.state.epoch.number);
    if (!previous) throw new Error('missing-epoch-key');
    const next = randomBytes(32);
    const epoch = ledger.state.epoch.number + 1;
    const packet = sealHistoryPacket(next, previous, this.genesis, epoch);
    const submitted = await this.submit({
      type: 'publishEpoch',
      epoch,
      commitment: await commitEpochKey(this.genesis, epoch, next),
      previousEpochKey: packet,
    });
    if (submitted.status !== 'committed') throw new Error(`rotate-${submitted.status}`);
    this.epochKeys.set(epoch, next);
    this.epoch = epoch;
  }

  async revokeFirstOtherMember(): Promise<void> {
    const ledger = await this.readLedger();
    const mine = deviceHex(this.device);
    for (const [id, device] of ledger.state.devices) {
      if (id === mine) continue;
      const result = await this.submit({ type: 'removeMember', membershipId: device.membershipId });
      if (result.status !== 'committed') throw new Error(`revoke-${result.status}`);
      return;
    }
    throw new Error('no-other-member');
  }

  async admitDevice(
    target: DemoDevice,
    kind: 'personal' | 'machine' | 'recovery',
    canManage: boolean
  ): Promise<{ status: string }> {
    if (!this.genesisHex) throw new Error('no-space');
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

  async recoverEpochHistory(): Promise<void> {
    if (!this.genesis || !this.genesisHex) throw new Error('no-space');
    const ledger = await this.readLedger();
    const latest = this.epochKeys.get(ledger.state.epoch.number);
    if (!latest) throw new Error('missing-epoch-key');
    const decoded = decodeRecord(this.genesis);
    if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
    const records = [this.genesis, ...(await this.suffixRecords())];
    this.epochKeys = await recoverHistory({
      genesis: this.genesis,
      latestEpoch: ledger.state.epoch.number,
      latestKey: latest,
      packets: collectEpochPackets(records, decoded.body.fields.epochCommitment),
    });
    this.keysReceived = this.epochKeys.size;
  }

  private async suffixRecords(): Promise<Uint8Array[]> {
    const client = new StreamsClient({
      url: `${this.baseUrl}/ds/${encodeURIComponent(this.genesisHex!)}/${CONTROL_STREAM}`,
      fetch: (input, init) => fetch(input, { ...init, headers: this.headers(init?.headers) }),
      retry: { maxAttempts: 0 },
    });
    const records: Uint8Array[] = [];
    let offset = '-1';
    for (let page = 0; page < 256; page++) {
      const response = await client.read({ offset });
      if (!response.ok) break;
      const body = new Uint8Array(response.result.payload.body);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let start = 0;
      while (body.length - start >= 4) {
        const length = view.getUint32(start, false);
        records.push(body.slice(start + 4, start + 4 + length));
        start += 4 + length;
      }
      offset = response.result.nextOffset;
      if (response.result.upToDate) break;
    }
    return records;
  }

  async exportRecoveryFile(): Promise<Uint8Array> {
    const { createRecoveryDeviceSecret, importRecoveryDevice } = await import('@lody/e2ee-core');
    const recovery = await createRecoveryDeviceSecret();
    const handle = await importRecoveryDevice(recovery.secret);
    const admitted = await this.admitDevice(recoveryAsDevice(handle), 'recovery', false);
    if (admitted.status !== 'committed') throw new Error(`admit-r-${admitted.status}`);
    return exportBackup(this, { secret: recovery.secret, publicKey: recovery.publicKey });
  }

  async restoreRecoveryFile(backup: Uint8Array): Promise<void> {
    const opened = await restoreBackup(this, backup);
    this.device = recoveryAsDevice(opened.recovery);
    await this.reauth();
    const phone = await generateDevice();
    const added = await this.admitDevice(phone, 'personal', false);
    if (added.status !== 'committed') throw new Error(`restore-admit-${added.status}`);
    this.device = phone;
    await this.reauth();
    await this.readLedger();
  }
}

export function compareLabel(kind: string): string {
  if (kind === 'agree') return 'checked';
  if (kind === 'conflict' || kind === 'different-org') return 'inconsistent';
  if (kind === 'pending-sync') return 'pending';
  return kind || 'none';
}
