import { useState } from 'react';
import { BrowserSession, compareLabel } from './browser-session';

export function App() {
  const [account, setAccount] = useState('alice');
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [genesis, setGenesis] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [length, setLength] = useState(0);
  const [compareKind, setCompareKind] = useState('');
  const [log, setLog] = useState('');

  function fail(error: unknown) {
    setStatus('failed');
    setLog(error instanceof Error ? error.message : String(error));
  }

  async function connect() {
    try {
      const next = new BrowserSession(window.location.origin, account);
      await next.start();
      setSession(next);
      setStatus('connected');
      setLog(`device ${account}`);
    } catch (error) {
      fail(error);
    }
  }

  async function createSpace() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const hex = await session.createSpace();
      setGenesis(hex);
      setLength(session.length);
      setStatus('connected');
      setLog(`created ${hex}`);
    } catch (error) {
      fail(error);
    }
  }

  async function join() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.requestJoin(genesis.trim());
      setLength(session.length);
      setStatus('connected');
      setLog('join requested');
    } catch (error) {
      fail(error);
    }
  }

  async function approve() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.approveFirstJoin();
      setLength(session.length);
      setStatus('connected');
      setLog('join approved');
    } catch (error) {
      fail(error);
    }
  }

  async function note() {
    if (!session) return fail(new Error('not-connected'));
    try {
      await session.publishNote();
      setLength(session.length);
      setLog('note published');
    } catch (error) {
      fail(error);
    }
  }

  async function compare() {
    if (!session) return fail(new Error('not-connected'));
    try {
      const kind = await session.compare();
      setCompareKind(kind);
      setLength(session.length);
      setLog(`compare ${kind}`);
    } catch (error) {
      fail(error);
    }
  }

  const label = compareLabel(compareKind);

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
        Compare notes
      </button>
      <output id="status">{status}</output>
      <output id="length">{String(length)}</output>
      <output id="compare-kind">{compareKind}</output>
      <output id="compare-label">{label}</output>
      <pre id="log">{log}</pre>
    </div>
  );
}
