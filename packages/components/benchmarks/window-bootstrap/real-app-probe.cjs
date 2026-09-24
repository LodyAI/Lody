const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');

app.setAppPath(process.env.PROBE_APP_PATH);
app.setPath('userData', process.env.LODY_ELECTRON_USER_DATA_DIR);
const output = process.env.PROBE_OUTPUT;
for (const name of [
  'LODY_DATA_DIR',
  'LODY_ELECTRON_USER_DATA_DIR',
  'PROBE_OUTPUT',
  'PROBE_FIXTURE',
]) {
  if (!process.env[name]) throw new Error('Missing isolated probe configuration: ' + name);
}
const repeats = Number(process.env.PROBE_REPEATS ?? 10);
const rounds = Number(process.env.PROBE_ROUNDS ?? 1500);
const answer = 'Answer for round ' + (rounds - 1) + '.';
const preparedMode = process.env.PROBE_PREPARED === '1';
const productPreparedMode = process.env.PROBE_PRODUCT_PREPARED === '1';
const checkInput = process.env.PROBE_INPUT === '1';
const intentLeadMs = process.env.PROBE_INTENT_LEAD_MS === undefined ? null : Number(process.env.PROBE_INTENT_LEAD_MS);
if (intentLeadMs !== null && (!Number.isFinite(intentLeadMs) || intentLeadMs < 0)) throw new Error('Invalid intent lead time');
const nativeHost = process.env.PROBE_NATIVE_ADDON ? require(process.env.PROBE_NATIVE_ADDON) : null;
let heldWindow = null;
let sourceWindow = null;
const appFocus = app.focus.bind(app);
app.focus = (...args) => (heldWindow?.__holdPresentation ? undefined : appFocus(...args));
ipcMain.handle('app.benchmarkPresent', (event) => {
  if (
    event.sender !== sourceWindow?.webContents ||
    !heldWindow?.__prepared ||
    heldWindow.isDestroyed() ||
    !heldWindow.__holdPresentation
  ) {
    throw new Error('No matching prepared probe window');
  }
  const win = heldWindow;
  win.__holdPresentation = false;
  win.__claim = performance.now();
  log({ kind: 'prepared-claim', id: win.id, at: win.__claim });
  win.show();
  win.focus();
});
const records = [];
const log = (x) => {
  records.push(x);
  fs.appendFileSync(output + '.jsonl', JSON.stringify(x) + '\n');
};
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, (event, ...args) => {
  if (channel === 'app.prepareWindow' || channel === 'app.cancelPreparedWindow')
    log({ kind: 'intent-ipc', channel, sourceVisible: BrowserWindow.fromWebContents(event.sender)?.isVisible(), args });
  return handler(event, ...args);
});
let running = null;
app.on('browser-window-created', (_createdEvent, win) => {
  win.__created = performance.now();
  const wc = win.webContents;
  const send = wc.send.bind(wc);
  const show = win.show.bind(win);
  const focus = win.focus.bind(win);
  win.focus = () => (win.__holdPresentation ? undefined : focus());
  if (nativeHost) nativeHost.disableAnimation(win.getNativeWindowHandle());
  win.show = () => {
    if (win.__holdPresentation) {
      win.__prepared = true;
      win.__prepareMs = performance.now() - win.__claim;
      win.__resolvePrepared?.();
      return;
    }
    if (win.__claim)
      log({ kind: 'native-show-start', id: win.id, afterClaimMs: performance.now() - win.__claim });
    show();
  };
  wc.send = (channel, ...args) => {
    if (channel === 'app.prepareWindowTarget') {
      win.__preparing = args[0];
      win.__prepareStarted = performance.now();
      log({ kind: 'prepare-target', id: win.id, at: win.__prepareStarted });
    }
    if (channel === 'app.windowTarget') {
      win.__claim ??= performance.now();
      log({
        kind: 'claim',
        id: win.id,
        at: win.__claim,
        hidden: !win.isVisible(),
        target: args[0],
      });
    }
    return send(channel, ...args);
  };
  wc.on('ipc-message', (_, channel, state) => {
    if (channel === 'app.preparedWindowState') {
      win.__targetReady = state.ready;
      if (state.ready) win.__prepareMs = performance.now() - win.__prepareStarted;
      log({ kind: 'prepared-state', id: win.id, ready: state.ready });
    }
    if (channel === 'app.windowReady') win.__shellReady = true;
    if (channel === 'app.windowContentReady' && win.__claim)
      log({ kind: 'content-ready', id: win.id, afterClaimMs: performance.now() - win.__claim });
  });
  wc.on('console-message', (_, level, message) => {
    if (message.startsWith('RuntimeProvider:'))
      log({ kind: 'runtime', id: win.id, message, at: performance.now() });
  });
  const checkShownWindow = async () => {
    if (!win.__claim) return;
    const claimToShowMs = performance.now() - win.__claim;
    log({ kind: 'native-show-event', id: win.id, claimToShowMs });
    try {
      const capture = wc.capturePage().then(image => { log({kind: 'capture-complete', id: win.id}); return image; });
      const inputResult = checkInput
        ? (async () => {
            const token = 'prepared-window-probe-' + win.id;
            const focused = await wc.executeJavaScript(`(() => {
        const input = document.querySelector('textarea[data-lody-composer-input]');
        if (!input || input.disabled || input.readOnly) return false;
        input.focus();
        return document.activeElement === input && !input.value.includes(${JSON.stringify(token)});
      })()`);
            if (!focused) throw new Error('Composer not editable at first show');
            await wc.insertText(token);
            log({kind: 'input-inserted', id: win.id});
            await wc.executeJavaScript(
              'new Promise(resolve => requestAnimationFrame(() => resolve()))'
            );
            log({kind: 'input-frame', id: win.id});
            const accepted = await wc.executeJavaScript(
              `document.querySelector('textarea[data-lody-composer-input]')?.value.includes(${JSON.stringify(token)})`
            );
            if (!accepted) {
              const details = await wc.executeJavaScript(`JSON.stringify({
                value: document.querySelector('textarea[data-lody-composer-input]')?.value,
                active: document.activeElement?.outerHTML,
                focused: document.hasFocus()
              })`);
              throw new Error('Composer did not accept native text insertion: ' + details);
            }
            return { accepted, token, claimToInputObservedMs: performance.now() - win.__claim };
          })()
        : Promise.resolve(null);
      void inputResult.catch(() => {});
      void capture.catch(() => {});
      const state = await wc.executeJavaScript(
        `({ready:!!document.querySelector('[data-window-session-ready]'),answer:document.body.innerText.includes(${JSON.stringify(answer)}),loading:document.body.innerText.includes('Loading'),missing:document.body.innerText.includes('Session not found'),streamVisible:(()=>{const e=document.querySelector('[data-message-selection-scroll]');return !!e && getComputedStyle(e).visibility==='visible'})()})`
      );
      const screenshot = output + '-' + win.id + '.png';
      const [captured, input] = await Promise.all([capture, inputResult]);
      fs.writeFileSync(screenshot, captured.toPNG());
      const row = {
        kind: 'shown',
        id: win.id,
        claimToShowMs,
        state,
        screenshot,
        input,
        preparationMs: win.__prepareMs ?? null,
      };
      log(row);
      running?.resolve(row);
    } catch (error) {
      running?.reject(error);
    }
  };
  win.on('show', () => {
    void checkShownWindow().catch(error => running?.reject(error));
  });
});
require(process.env.PROBE_ENTRY);
const waitFor = async (check, label) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out: ' + label);
};
void app.whenReady().then(async () => {
  try {
    const source = await waitFor(
      () =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')),
      'main window'
    );
    await waitFor(
      () =>
        source.webContents
          .executeJavaScript(
            "(async()=>!!window.repo && (await window.repo.listDoc()).some(x=>x.docId.startsWith('machine-')))()"
          )
          .catch(() => false),
      'source Repo'
    );
    sourceWindow = source;
    const binary = fs.readFileSync(process.env.PROBE_FIXTURE, 'utf8');
    await source.webContents.executeJavaScript(`(async()=>{
 const repo=window.repo;const machine=(await repo.listDoc()).find(x=>x.docId.startsWith('machine-')).meta;
 const sessionId='session-conversation-view-fixture';const room='session-'+sessionId;
 const handle=await repo.acquireDoc(room);window.__syntheticSession=handle;
 handle.doc.import(Uint8Array.from(atob(${JSON.stringify(binary)}),x=>x.charCodeAt(0)));
 await repo.upsertDocMeta(room,{id:sessionId,machineId:machine.id,userId:machine.ownerUserId,createdAt:new Date().toISOString(),lastMessageAt:Date.now(),title:'Warm window benchmark — synthetic ${rounds * 2} entries',status:'idle',cliType:'builtin',agentType:'claude',isArchived:false});
 await repo.flush();location.hash='/local/sessions/'+sessionId;
 })()`);
    await waitFor(
      () =>
        source.webContents.executeJavaScript(
          `!!document.querySelector('[data-window-session-ready]') && document.body.innerText.includes(${JSON.stringify(answer)})`
        ),
      'source conversation'
    );
    await source.webContents.executeJavaScript(
      `window.ipc.invoke('app.setDevbarControl',{enabled:false,agentAccess:false,warmupEnabled:true})`
    );
    const results = [];
    for (let i = 0; i < repeats + 3; i++) {
      const spare = await waitFor(
        () =>
          BrowserWindow.getAllWindows().find(
            (w) =>
              w !== source &&
              !w.isVisible() &&
              w.__shellReady &&
              !w.__claim &&
              performance.now() - w.__created >= 1500
          ),
        'idle spare'
      );
      const prepared = await spare.webContents.executeJavaScript(
        `(async()=>({repo:!!window.repo,metadata:window.repo?(await window.repo.listDoc()).some(x=>x.docId==='session-session-conversation-view-fixture'):false}))()`
      );
      if (process.env.PROBE_CPU_PROFILE === '1') {
        spare.webContents.debugger.attach('1.3');
        await spare.webContents.debugger.sendCommand('Profiler.enable');
        await spare.webContents.debugger.sendCommand('Profiler.start');
      }
      if (productPreparedMode) {
        await source.webContents.executeJavaScript(`(async () => {
          const room = 'session-session-conversation-view-fixture';
          const meta = (await window.repo.getDocMeta(room)).meta;
          await window.repo.upsertDocMeta(room, { ...meta, lastReadAt: 0 });
          const row = document.querySelector('[data-sidebar-session-id="session-conversation-view-fixture"]');
          if (!row) throw new Error('Missing real Session row');
          row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
          row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        })()`);
        if (intentLeadMs === null) await waitFor(() => spare.__targetReady, 'production prepared Session');
        else await new Promise(resolve => setTimeout(resolve, intentLeadMs));
        if (spare.isVisible()) throw new Error('Speculative window became visible');
        const untouched = await source.webContents.executeJavaScript(`(async () =>
          (await window.repo.getDocMeta('session-session-conversation-view-fixture')).meta.lastReadAt === 0)()`);
        const targetUnread = !spare.__preparing || await spare.webContents.executeJavaScript(`(async () =>
          (await window.repo.getDocMeta('session-session-conversation-view-fixture')).meta.lastReadAt === 0)()`);
        if (!untouched || !targetUnread) throw new Error('Preparation marked Session read');
        log({ kind: 'speculative-side-effects', id: spare.id, unreadPreserved: true, hidden: true });
      }
      if (preparedMode) {
        heldWindow = spare;
        spare.__holdPresentation = true;
        const ready = new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error('Target preparation timed out')),
            10000
          );
          spare.__resolvePrepared = () => {
            clearTimeout(deadline);
            resolve();
          };
        });
        await source.webContents.executeJavaScript(
          `window.ipc.invoke('app.openWindow',{workspace:'local',sessionId:'session-conversation-view-fixture'})`
        );
        await ready;
        if (spare.isVisible()) throw new Error('Prepared target escaped hidden host');
        const valid = await spare.webContents.executeJavaScript(
          `!!document.querySelector('[data-window-session-stream-ready="session-conversation-view-fixture"]') &&
            document.body.innerText.includes(${JSON.stringify(answer)})`
        );
        if (!valid) throw new Error('Recovery timeout is not prepared content');
      }
      const shown = new Promise((resolve, reject) => {
        running = { resolve, reject };
      });
      const timeout = setTimeout(() => running?.reject(new Error('No show')), 10000);
      const readyAtClick = Boolean(spare.__targetReady);
      const started = performance.now();
      if (productPreparedMode) spare.__claim = started;
      await source.webContents.executeJavaScript(
        preparedMode
          ? `window.ipc.invoke('app.benchmarkPresent')`
          : productPreparedMode
            ? `document.querySelector('[data-sidebar-session-id="session-conversation-view-fixture"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))`
            : `window.ipc.invoke('app.openWindow',{workspace:'local',sessionId:'session-conversation-view-fixture'})`
      );
      const row = await shown;
      clearTimeout(timeout);
      running = null;
      if (
        !row.state.ready ||
        !row.state.answer ||
        !row.state.streamVisible ||
        row.state.loading ||
        row.state.missing
      )
        throw new Error('First show did not contain visible conversation content');
      if (row.id !== spare.id) throw new Error('Did not claim expected spare');
      if (process.env.PROBE_CPU_PROFILE === '1') {
        const { profile } = await spare.webContents.debugger.sendCommand('Profiler.stop');
        fs.writeFileSync(output + '-' + spare.id + '.cpuprofile', JSON.stringify(profile));
        spare.webContents.debugger.detach();
      }
      results.push({
        ...row,
        prepared,
        readyAtClick,
        requestToProbeCompleteMs: performance.now() - started,
        warmup: i < 3,
      });
      heldWindow = null;
      const closed = new Promise((resolve) => spare.once('closed', resolve));
      spare.close();
      await closed;
    }
    fs.writeFileSync(
      output + '.json',
      JSON.stringify(
        {
          variant: process.env.PROBE_VARIANT,
          preparedMode,
          productPreparedMode,
          nativeAnimationDisabled: !!nativeHost,
          timingBoundary: productPreparedMode ? 'source row Command-click dispatch' : preparedMode ? 'prepared host presentation IPC' : 'target navigation IPC',
          intentLeadMs,
          hitRate: productPreparedMode ? results.filter(r => !r.warmup && r.readyAtClick).length / repeats : preparedMode ? 1 : null,
          entries: rounds * 2,
          spareMinimumAgeMs: 1500,
          source: 'real desktop renderer / synthetic CRDT fixture / bundled CLI',
          results,
          records,
        },
        null,
        2
      )
    );
    console.log('PROBE_RESULT ' + output + '.json');
  } catch (error) {
    console.error(error);
    fs.writeFileSync(
      output + '.failure.json',
      JSON.stringify({ error: String(error), records }, null, 2)
    );
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
