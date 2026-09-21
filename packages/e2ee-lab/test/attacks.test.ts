import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeSignedRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { generateDevice } from '../src/platform/device';
import { fromHex } from '../src/platform/bytes';
import { HonestClient } from '../src/actors';
import { appendControlRecord } from '../src/attacks';
import { startLabBackend, type LabBackend } from '../src/backend';
import { defectiveAcceptInvalid, judgeImport } from '../src/judge';

const dirs: string[] = [];
const hosts: LabBackend[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    try {
      await hosts.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('P3 judge and real control tamper', () => {
  it('marks a known defective importer as a violation', () => {
    expect(defectiveAcceptInvalid({ invalidRecord: true, accepted: true })).toBe('violation');
    expect(defectiveAcceptInvalid({ invalidRecord: true, accepted: false })).toBe('pass');
    // Backend growth alone is diagnostic, not client integrity loss.
    expect(judgeImport({ rejected: true, ledgerLength: 1, expectedLength: 1 })).toBe('pass');
    expect(judgeImport({ rejected: false, ledgerLength: 2, expectedLength: 1 })).toBe('pass');
  });

  it('rejects a tampered signature on the real backend without advancing the cursor', async () => {
    const host = await startLabBackend({
      dataDir: mkdtempSync(join(tmpdir(), 'e2ee-lab-attack-')),
      host: '127.0.0.1',
      port: 0,
      testMode: true,
    });
    hosts.push(host);
    dirs.push(host.dataDir);
    const alice = new HonestClient({
      baseUrl: host.baseUrl,
      clientDir: mkdtempSync(join(tmpdir(), 'e2ee-lab-attack-alice-')),
      account: 'alice',
      testMode: true,
    });
    dirs.push(alice.clientDir);
    await alice.start();
    await alice.createSpace();
    const ledger = await alice.readLedger();
    const extra = await generateDevice();
    const proposal = ledger.prepare(
      {
        type: 'admitDevice',
        kind: 'personal',
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        canManage: false,
        possessionSignature: await extra.sign(
          possessionSigningBytes({
            genesis: fromHex(alice.genesisHex!),
            targetMembershipId: ledger.state.owner,
            signingPublicKey: extra.publicKey,
            encryptionPublicKey: extra.enc,
            kind: 'personal',
            canManage: false,
          })
        ),
      },
      alice.device.publicKey
    );
    const signature = await alice.device.sign(signingBytesForBody(proposal.bodyBytes));
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    const record = encodeSignedRecord(proposal.bodyBytes, signature);
    const posted = await appendControlRecord({
      baseUrl: host.baseUrl,
      client: alice,
      genesisHex: alice.genesisHex!,
      record,
    });
    expect(posted.ok).toBe(false);
    let rejected = false;
    try {
      await alice.readLedger();
    } catch {
      rejected = true;
    }
    const length = (await alice.readLedger().catch(() => ledger)).length;
    expect(
      judgeImport({ rejected: rejected || length === 1, ledgerLength: length, expectedLength: 1 })
    ).toBe('pass');
    expect(length).toBe(1);
  });
});
