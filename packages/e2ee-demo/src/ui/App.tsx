import { useState } from 'react';
import { asArrayBuffer } from '../bytes';
import { BrowserSession, compareLabel } from './browser-session';

export function App() {
  const [account, setAccount] = useState('alice');
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [genesis, setGenesis] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [length, setLength] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [compareKind, setCompareKind] = useState('');
  const [compareSource, setCompareSource] = useState<'server' | 'independent'>('server');
  const [compareIndependentFlag, setCompareIndependentFlag] = useState(false);
  const [noteExport, setNoteExport] = useState('');
  const [noteImport, setNoteImport] = useState('');
  const [log, setLog] = useState('');
  const [loroInput, setLoroInput] = useState('hello-e2ee');
  const [loroValue, setLoroValue] = useState('');
  const [flockInput, setFlockInput] = useState('flock-secret');
  const [flockValue, setFlockValue] = useState('');
  const [keysReceived, setKeysReceived] = useState(0);

  function fail(error: unknown) {
    setStatus('failed');
    setLog(error instanceof Error ? error.message : String(error));
  }

  function refresh(next: BrowserSession, message: string) {
    setLength(next.length);
    setEpoch(next.epoch);
    setKeysReceived(next.epochKeys.size);
    setStatus('connected');
    setLog(message);
  }

  async function connect() {
    try {
      const next = new BrowserSession(window.location.origin, account);
      await next.start();
      setSession(next);
      if (next.genesisHex) setGenesis(next.genesisHex);
      refresh(next, next.genesisHex ? `restored ${next.genesisHex}` : `device ${account}`);
    } catch (error) {
      fail(error);
    }
  }

  async function createSpace() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const hex = await session.createSpace();
      setGenesis(hex);
      refresh(session, `created ${hex}`);
    } catch (error) {
      fail(error);
    }
  }

  async function join() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.requestJoin(genesis.trim());
      refresh(session, 'join requested');
    } catch (error) {
      fail(error);
    }
  }

  async function approve() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.approveFirstJoin();
      refresh(session, 'join approved');
    } catch (error) {
      fail(error);
    }
  }

  async function note() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const exported = await session.exportNote();
      setNoteExport(JSON.stringify(exported));
      await session.publishNote();
      refresh(session, 'note published');
    } catch (error) {
      fail(error);
    }
  }

  async function compare() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const result = await session.compareRemote();
      setCompareKind(result.kind);
      setCompareSource('server');
      setCompareIndependentFlag(false);
      refresh(session, `compare ${result.kind}`);
    } catch (error) {
      fail(error);
    }
  }

  async function compareImported() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const result = await session.compareIndependent(JSON.parse(noteImport) as never);
      setCompareKind(result.kind);
      setCompareSource('independent');
      setCompareIndependentFlag(result.independent === true);
      refresh(session, `independent ${result.kind}`);
    } catch (error) {
      fail(error);
    }
  }

  async function deliverKey() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const sent = await session.deliverToOthers();
      refresh(session, `delivered ${sent}`);
    } catch (error) {
      fail(error);
    }
  }

  async function receiveKey() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const opened = await session.receivePendingKeys();
      setKeysReceived(session.epochKeys.size);
      refresh(session, `received ${opened}`);
    } catch (error) {
      fail(error);
    }
  }

  async function writeLoroText() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { writeLoro } = await import('../content-session');
      await writeLoro(session, loroInput);
      refresh(session, 'loro written');
    } catch (error) {
      fail(error);
    }
  }

  async function readLoroText() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { readLoro } = await import('../content-session');
      const text = await readLoro(session);
      setLoroValue(text);
      refresh(session, 'loro read');
    } catch (error) {
      fail(error);
    }
  }

  async function writeFlockText() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { writeFlock } = await import('../content-session');
      await writeFlock(session, flockInput);
      refresh(session, 'flock written');
    } catch (error) {
      fail(error);
    }
  }

  async function readFlockText() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { readFlock } = await import('../content-session');
      const text = await readFlock(session);
      setFlockValue(text);
      refresh(session, 'flock read');
    } catch (error) {
      fail(error);
    }
  }

  async function uploadSnapshot() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { uploadLoroSnapshot } = await import('../content-session');
      await uploadLoroSnapshot(session, loroInput);
      refresh(session, 'snapshot uploaded');
    } catch (error) {
      fail(error);
    }
  }

  async function bootstrapSnapshot() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const { bootstrapLoroFromSnapshot } = await import('../content-session');
      const result = await bootstrapLoroFromSnapshot(session, loroInput);
      setLoroValue(result.text);
      refresh(session, 'snapshot bootstrapped');
    } catch (error) {
      fail(error);
    }
  }

  async function revoke() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.revokeFirstOtherMember();
      refresh(session, 'member revoked');
    } catch (error) {
      fail(error);
    }
  }

  async function rotate() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.publishEpoch();
      refresh(session, `rotated ${session.epoch}`);
    } catch (error) {
      fail(error);
    }
  }

  async function exportFile() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const bytes = await session.exportRecoveryFile();
      const blob = new Blob([asArrayBuffer(bytes)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.id = 'backup-download';
      link.href = url;
      link.download = 'e2ee-demo.backup';
      document.body.append(link);
      link.click();
      refresh(session, 'backup exported');
    } catch (error) {
      fail(error);
    }
  }

  async function importFile(file: File | undefined) {
    if (!session) return fail(new Error('not-connected'));
    if (!file) return fail(new Error('no-backup-file'));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await session.restoreRecoveryFile(bytes);
      if (session.genesisHex) setGenesis(session.genesisHex);
      refresh(session, 'backup restored');
    } catch (error) {
      fail(error);
    }
  }

  const label = compareLabel(compareKind, compareSource, compareIndependentFlag);

  return (
    <div>
      <h1>Independent E2EE demo</h1>
      <p>
        Local-only. The account picker is not a product login. Device keys, signatures, invite
        approval and authorization are real. Isolated browser contexts must not share keys.
      </p>
      <label>
        Account
        <select id="account" value={account} onChange={(event) => setAccount(event.target.value)}>
          <option>alice</option>
          <option>bob</option>
          <option>carol</option>
        </select>
      </label>
      <button id="connect" onClick={() => void connect()}>
        Connect
      </button>
      <button id="create" onClick={() => void createSpace()}>
        Create space
      </button>
      <label>
        Genesis
        <input
          id="genesis"
          size={40}
          value={genesis}
          onChange={(event) => setGenesis(event.target.value)}
        />
      </label>
      <button id="join" onClick={() => void join()}>
        Request join
      </button>
      <button id="approve" onClick={() => void approve()}>
        Approve first pending join
      </button>
      <button id="note" onClick={() => void note()}>
        Publish digest note
      </button>
      <button id="compare" onClick={() => void compare()}>
        Compare server notes (untrusted)
      </button>
      <label>
        Exported note
        <textarea id="note-export" rows={3} value={noteExport} readOnly />
      </label>
      <label>
        Import note (paste / QR text)
        <textarea
          id="note-import"
          rows={3}
          value={noteImport}
          onChange={(event) => setNoteImport(event.target.value)}
        />
      </label>
      <button id="compare-independent" onClick={() => void compareImported()}>
        Compare imported note
      </button>
      <p>
        checked only after pasting another member's note (not the original space creator, not a
        server copy). Server compare is untrusted.
      </p>
      <h2>Keys and devices</h2>
      <button id="deliver-key" onClick={() => void deliverKey()}>
        Deliver epoch key
      </button>
      <button id="receive-key" onClick={() => void receiveKey()}>
        Receive epoch key
      </button>
      <button id="revoke" onClick={() => void revoke()}>
        Revoke other member
      </button>
      <button id="rotate" onClick={() => void rotate()}>
        Rotate epoch
      </button>
      <h2>Encrypted documents</h2>
      <label>
        Loro text
        <input
          id="loro-input"
          value={loroInput}
          onChange={(event) => setLoroInput(event.target.value)}
        />
      </label>
      <button id="loro-write" onClick={() => void writeLoroText()}>
        Write Loro
      </button>
      <button id="loro-read" onClick={() => void readLoroText()}>
        Read Loro
      </button>
      <button id="snapshot-upload" onClick={() => void uploadSnapshot()}>
        Upload snapshot
      </button>
      <button id="snapshot-bootstrap" onClick={() => void bootstrapSnapshot()}>
        Bootstrap snapshot
      </button>
      <output id="loro-value">{loroValue}</output>
      <label>
        Flock value
        <input
          id="flock-input"
          value={flockInput}
          onChange={(event) => setFlockInput(event.target.value)}
        />
      </label>
      <button id="flock-write" onClick={() => void writeFlockText()}>
        Write Flock
      </button>
      <button id="flock-read" onClick={() => void readFlockText()}>
        Read Flock
      </button>
      <output id="flock-value">{flockValue}</output>
      <h2>File restore</h2>
      <button id="export-backup" onClick={() => void exportFile()}>
        Export backup
      </button>
      <input
        id="import-backup"
        type="file"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <output id="status">{status}</output>
      <output id="length">{String(length)}</output>
      <output id="epoch">{String(epoch)}</output>
      <output id="keys-received">{String(keysReceived)}</output>
      <output id="compare-kind">{compareKind}</output>
      <output id="compare-label">{label}</output>
      <pre id="log">{log}</pre>
    </div>
  );
}
