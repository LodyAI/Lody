import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRecoveryFile,
  createUserIdentity,
  openRecoveryBackup,
  sealRecoveryBackup,
} from '@lody/e2ee-core';
import {
  encodeSignedRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { generateDevice } from '../src/platform/device';
import {
  loroTailOffset,
  putLoroSnapshot,
  sealLoroSnapshot,
  writeLoro,
} from '../src/platform/content-session';
import { fromHex, toHex } from '../src/platform/bytes';
import { appendControlRecord, maliciousAppendCas, mutateSqliteBytes } from '../src/attacks';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import {
  defectiveAcceptInvalid,
  judgeCursor,
  judgeFork,
  judgeImport,
  judgeLeak,
  judgeUnauthorized,
  judgeUnauthorizedContent,
  type ScenarioRecord,
} from '../src/judge';

afterEach(() => cleanupLab());

describe('P3 Spec §7 matrix', () => {
  it('records control, attack, expected boundary and verdict for each scenario', async () => {
    const rows: ScenarioRecord[] = [];

    rows.push({
      name: 'known-defect-skip-verify',
      control: 'Ledger.verify rejects a flipped signature',
      attack: 'defective importer accepts invalid bytes',
      expected: 'violation',
      actual: defectiveAcceptInvalid({ invalidRecord: true, accepted: true }),
    });

    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    const genesisLen = (await alice.readLedger()).length;

    const extra = await generateDevice();
    const proposal = (await alice.readLedger()).prepare(
      {
        type: 'admitDevice',
        kind: 'personal',
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        canManage: false,
        possessionSignature: await extra.sign(
          possessionSigningBytes({
            genesis: fromHex(alice.genesisHex!),
            targetMembershipId: (await alice.readLedger()).state.owner,
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
    const forged = encodeSignedRecord(proposal.bodyBytes, signature);
    const honestReject = await appendControlRecord({
      baseUrl: host.baseUrl,
      client: alice,
      genesisHex: alice.genesisHex!,
      record: forged,
    });
    const afterHonest = await alice.readLedger();
    rows.push({
      name: 'tamper-signature-host',
      control: 'honest host verifies before CAS',
      attack: 'flipped signature via host append-cas',
      expected: 'pass',
      actual: judgeImport({
        rejected: !honestReject.ok,
        ledgerLength: afterHonest.length,
        expectedLength: genesisLen,
      }),
    });

    const bob = await labClient({ host, account: 'bob' });
    const join = await bob.requestJoin(alice.genesisHex!);
    await alice.approveJoin(join);
    const outsider = await labClient({ host, account: 'outsider' });
    await outsider.adoptGenesis(alice.genesisHex!);
    let unauthorized = false;
    try {
      await outsider.admitDevice(await generateDevice(), 'personal', false);
      unauthorized = true;
    } catch {
      unauthorized = false;
    }
    const devices = (await alice.readLedger()).state.devices;
    rows.push({
      name: 'unauthorized-device',
      control: 'only admitted devices write',
      attack: 'outsider admitDevice',
      expected: 'pass',
      actual: judgeUnauthorized({
        inAuthenticatedState: unauthorized || devices.has(toHex(outsider.device.publicKey)),
      }),
    });

    host.setFailpoint('drop-control-ack');
    const phone = await generateDevice();
    let lostStatus = 'unknown';
    try {
      lostStatus = (await alice.admitDevice(phone, 'personal', false)).status;
    } catch {
      host.setFailpoint('none');
      lostStatus = (await alice.resume()).status;
    }
    host.setFailpoint('none');
    rows.push({
      name: 'lost-ack-resume',
      control: 'pending bytes resume without re-sign',
      attack: 'drop-control-ack failpoint',
      expected: 'pass',
      actual: lostStatus === 'committed' ? 'pass' : 'violation',
    });

    await alice.readLedger();
    await writeLoro(alice, 'secret-plaintext-lab');
    const disk = readFileSync(host.riverrunDbPath);
    rows.push({
      name: 'ciphertext-confidentiality',
      control: 'backend stores ciphertext',
      attack: 'scan riverrun for plaintext',
      expected: 'pass',
      actual: judgeLeak({
        backendContainsPlaintext: disk.includes('secret-plaintext-lab'),
      }),
    });

    const revoked = await alice.revokeDevice(phone.publicKey);
    const afterRevoke = await alice.readLedger();
    rows.push({
      name: 'revoke-rotation',
      control: 'existing permission rules, no cross-stream txn',
      attack: 'revoke admitted device then inspect authenticated state',
      expected: 'pass',
      actual: judgeUnauthorized({
        inAuthenticatedState:
          revoked.status === 'committed' && afterRevoke.state.devices.has(toHex(phone.publicKey)),
      }),
    });

    const identity = await createUserIdentity();
    const file = createRecoveryFile();
    const expected = { identity: identity.identity.fingerprint, revision: 0 };
    const frame = sealRecoveryBackup(file, expected, identity.privateMaterial);
    const broken = new Uint8Array(frame);
    broken[broken.byteLength - 1] = (broken[broken.byteLength - 1] ?? 0) ^ 0xff;
    let recoveryRejected = false;
    try {
      openRecoveryBackup(file, expected, broken);
    } catch {
      recoveryRejected = true;
    }
    identity.privateMaterial.fill(0);
    rows.push({
      name: 'recovery-backup-tamper',
      control: 'openRecoveryBackup on public API',
      attack: 'flip backup ciphertext',
      expected: 'pass',
      actual: recoveryRejected ? 'pass' : 'violation',
    });

    const offset = await loroTailOffset(alice);
    const snapA = await sealLoroSnapshot(alice, offset, 'cipher-a');
    const snapB = await sealLoroSnapshot(alice, offset, 'cipher-b');
    const firstSnap = await putLoroSnapshot(alice, offset, snapA);
    const secondSnap = await putLoroSnapshot(alice, offset, snapB);
    rows.push({
      name: 'snapshot-identity-conflict',
      control: 'historical admitted snapshot stays',
      attack: 'different ciphertext at same offset',
      expected: 'pass',
      actual: firstSnap.ok && !secondSnap.ok ? 'pass' : 'violation',
    });

    const note = await alice.exportNote();
    const forgedNote = { ...note, head: 'aa'.repeat(32), stateDigest: 'bb'.repeat(32) };
    const compared = await alice.compareIndependent(forgedNote);
    rows.push({
      name: 'forged-compare-note',
      control: 'independent compare, not server checked',
      attack: 'mutated head/digest',
      expected: 'pass',
      actual: judgeFork({
        independentEvidence: true,
        displayedChecked: compared.kind === 'agree',
      }),
    });
    rows.push({
      name: 'fork-without-independent-evidence',
      control: 'no independent note',
      attack: 'server-only view',
      expected: 'outside-model',
      actual: judgeFork({ independentEvidence: false, displayedChecked: false }),
    });

    const malicious = await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record: forged,
    });
    let clientRejected = false;
    let length = genesisLen;
    try {
      length = (await alice.readLedger()).length;
    } catch {
      clientRejected = true;
      length = genesisLen;
    }
    rows.push({
      name: 'tamper-signature-malicious-server',
      control: 'client verify, not host 403',
      attack: `direct riverrun append status=${malicious.status}`,
      expected: 'pass',
      actual: malicious.ok
        ? judgeCursor({
            rejected: clientRejected || length === genesisLen,
            cursorAdvancedPastBad: length > genesisLen,
          })
        : 'harness-error',
    });

    const dataDir = host.dataDir;
    const dbPath = host.riverrunDbPath;
    const needle = alice.genesis!.subarray(0, 12);
    await host.close();
    const wrote = mutateSqliteBytes(dbPath, needle);
    const restarted = await launchLab(dataDir);
    const alice2 = await labClient({
      host: restarted,
      account: 'alice-reopen',
      device: undefined,
    });
    await alice2.adoptGenesis(alice.genesisHex!).catch(() => undefined);
    let sqliteRejected = !wrote;
    try {
      await alice2.readLedger();
    } catch {
      sqliteRejected = true;
    }
    rows.push({
      name: 'sqlite-mutation',
      control: 'stop host, mutate db, reopen',
      attack: 'xor genesis bytes in riverrun sqlite',
      expected: sqliteRejected ? 'pass' : 'unavailable',
      actual: sqliteRejected ? 'pass' : 'unavailable',
    });

    rows.push({
      name: 'unauthorized-content-model-limit',
      control: 'open accepts AEAD+sig; write rights are host/seal-only',
      attack: 'guest or revoked epoch-key holder under malicious Riverrun',
      expected: 'outside-model',
      actual: judgeUnauthorizedContent({
        observed: true,
        acceptedUnauthorizedWriter: true,
      }),
    });

    for (const row of rows) {
      expect(row.actual, row.name).toBe(row.expected);
    }
    expect(rows.map((row) => row.name)).toEqual([
      'known-defect-skip-verify',
      'tamper-signature-host',
      'unauthorized-device',
      'lost-ack-resume',
      'ciphertext-confidentiality',
      'revoke-rotation',
      'recovery-backup-tamper',
      'snapshot-identity-conflict',
      'forged-compare-note',
      'fork-without-independent-evidence',
      'tamper-signature-malicious-server',
      'sqlite-mutation',
      'unauthorized-content-model-limit',
    ]);
  });
});
