const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const directClickMode = process.env.PROBE_DIRECT_CLICK === '1';
const checkInput = process.env.PROBE_INPUT === '1';
const retargetMode = process.env.PROBE_RETARGET === '1';
const returnAfterMs = Number(process.env.PROBE_RETURN_MS ?? 0);
if (!Number.isFinite(returnAfterMs) || returnAfterMs < 0 || returnAfterMs > 7000)
  throw new Error('Return delay must be between zero and 7000 ms');
const intentLeadMs =
  process.env.PROBE_INTENT_LEAD_MS === undefined ? null : Number(process.env.PROBE_INTENT_LEAD_MS);
if (intentLeadMs !== null && (!Number.isFinite(intentLeadMs) || intentLeadMs < 0))
  throw new Error('Invalid intent lead time');
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
let unloadConfirmations = 0;
// Only synthetic, isolated probe windows run here. A clean close must not prompt.
dialog.showMessageBoxSync = () => {
  unloadConfirmations++;
  return 1;
};
const log = (x) => {
  records.push(x);
  fs.appendFileSync(output + '.jsonl', JSON.stringify(x) + '\n');
};
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  registerHandler(channel, (event, ...args) => {
    if (channel === 'app.prepareWindow' || channel === 'app.cancelPreparedWindow')
      log({
        kind: 'intent-ipc',
        channel,
        sourceVisible: BrowserWindow.fromWebContents(event.sender)?.isVisible(),
        args,
      });
    const started = performance.now();
    const result = handler(event, ...args);
    if (directClickMode && channel === 'sessionOwner.request') {
      const win = BrowserWindow.fromWebContents(event.sender);
      void Promise.resolve(result).then(
        () => {
          if (win?.__claim)
            log({
              kind: 'owner-request',
              id: win.id,
              method: args[0]?.method,
              afterClaimMs: started - win.__claim,
              durationMs: performance.now() - started,
            });
        },
        () => {}
      );
    }
    return result;
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
      win.__targetReady = false;
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
      const capture = wc.capturePage().then((image) => {
        log({ kind: 'capture-complete', id: win.id });
        return image;
      });
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
            log({ kind: 'input-inserted', id: win.id });
            await wc.executeJavaScript(
              'new Promise(resolve => requestAnimationFrame(() => resolve()))'
            );
            log({ kind: 'input-frame', id: win.id });
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
        `({ready:!!document.querySelector('[data-window-session-stream-ready="session-conversation-view-fixture"]'),answer:document.body.innerText.includes(${JSON.stringify(answer)}),loading:document.body.innerText.includes('Loading'),missing:document.body.innerText.includes('Session not found'),streamVisible:(()=>{const e=document.querySelector('[data-message-selection-scroll]');return !!e && getComputedStyle(e).visibility==='visible'})()})`
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
        openingTrace: directClickMode
          ? await wc.executeJavaScript(
              '({ stages: window.__openingStages, scroll: window.__lodyScrollEngineLog?.dump() })'
            )
          : undefined,
      };
      log(row);
      running?.resolve(row);
    } catch (error) {
      running?.reject(error);
    }
  };
  win.on('show', () => {
    void checkShownWindow().catch((error) => running?.reject(error));
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
    const sourceConversationStarted = performance.now();
    const binary = fs.readFileSync(process.env.PROBE_FIXTURE, 'utf8');
    await source.webContents.executeJavaScript(`(async()=>{
 const repo=window.repo;const machine=(await repo.listDoc()).find(x=>x.docId.startsWith('machine-')).meta;
 const sessionId='session-conversation-view-fixture';const room='session-'+sessionId;
 const handle=await repo.acquireDoc(room);
 handle.doc.import(Uint8Array.from(atob(${JSON.stringify(binary)}),x=>x.charCodeAt(0)));
 await repo.upsertDocMeta(room,{id:sessionId,machineId:machine.id,userId:machine.ownerUserId,createdAt:new Date().toISOString(),lastMessageAt:Date.now(),title:'Warm window benchmark — synthetic ${rounds * 2} entries',status:'idle',cliType:'builtin',agentType:'claude',isArchived:false});
 await repo.flush();handle.release();await repo.unloadDoc(room);
 if (${retargetMode}) {
   const neighbor = room + '-neighbor'; const copy = await repo.acquireDoc(neighbor);
   copy.doc.import(Uint8Array.from(atob(${JSON.stringify(binary)}),x=>x.charCodeAt(0)));
   await repo.upsertDocMeta(neighbor, {...(await repo.getDocMeta(room)).meta, id: sessionId+'-neighbor', title:'Synthetic neighboring Session'});
   await repo.flush();copy.release();await repo.unloadDoc(neighbor);
 }
 location.hash='/local/sessions/'+sessionId;
 })()`);
    await waitFor(
      () =>
        source.webContents.executeJavaScript(
          `!!document.querySelector('[data-window-session-ready]') && document.body.innerText.includes(${JSON.stringify(answer)})`
        ),
      'source conversation'
    );
    const sourceConversationMs = performance.now() - sourceConversationStarted;
    if (process.env.PROBE_RESIDENT_MEMORY === '1') {
      const residentMemory = await require('./resident-memory-probe.cjs')({
        source,
        answer,
        output,
        waitFor,
        log,
      });
      if (unloadConfirmations) throw new Error('Resident probe clean close triggered confirmation');
      fs.writeFileSync(
        output + '.json',
        JSON.stringify(
          {
            variant: process.env.PROBE_VARIANT,
            sharedSessionOwner: process.env.LODY_SHARED_SESSION_OWNER !== '0',
            entries: rounds * 2,
            unloadConfirmations,
            residentMemory,
          },
          null,
          2
        )
      );
      console.log('PROBE_RESULT ' + output + '.json');
      return;
    }
    await source.webContents.executeJavaScript(`window.ipc.invoke('app.setWindowWarmup',true)`);
    const results = [];
    const retained = [];
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
      if (directClickMode) {
        source.focus();
        if (spare.__preparing) throw new Error('Direct click must not prepare a target');
        await spare.webContents.executeJavaScript(`(() => {
          window.__openingStages = [];
          const record = (stage) => window.__openingStages.push({ stage, at: performance.now() });
          record('armed');
          const pending = new Map([
            ['session', '[data-window-session-ready]'],
            ['stream', '[data-message-selection-scroll]'],
            ['ready', '[data-window-session-stream-ready]'],
            ['composer', 'textarea[data-lody-composer-input]'],
          ]);
          const observer = new MutationObserver(() => {
            for (const [stage, selector] of pending) {
              if (document.querySelector(selector)) { record(stage); pending.delete(stage); }
            }
            if (!pending.size) observer.disconnect();
          });
          observer.observe(document, { subtree: true, childList: true, attributes: true,
            attributeFilter: ['data-window-session-ready', 'data-window-session-stream-ready'] });
          window.ipc.on('app.windowTarget', () => record('target'));
        })()`);
      } else if (productPreparedMode) {
        source.focus();
        if (retargetMode) {
          await source.webContents.executeJavaScript(
            `window.ipc.invoke('app.prepareWindow', {workspace:'local',sessionId:'session-conversation-view-fixture-neighbor'}, 'probe-neighbor-${i}')`
          );
          await waitFor(() => spare.__targetReady, 'neighboring prepared Session');
          spare.__neighborPid = spare.webContents.getOSProcessId();
        }
        await source.webContents.executeJavaScript(`(async () => {
          const room = 'session-session-conversation-view-fixture';
          const meta = (await window.repo.getDocMeta(room)).meta;
          await window.repo.upsertDocMeta(room, { ...meta, lastReadAt: 0 });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const row = document.querySelector('[data-sidebar-session-id="session-conversation-view-fixture"]');
          if (!row) throw new Error('Missing real Session row');
          row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
          row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, metaKey: ${process.env.PROBE_INTENT_META === '1'} }));
        })()`);
        if (intentLeadMs === null)
          await waitFor(
            () =>
              spare.__targetReady &&
              spare.__preparing?.sessionId === 'session-conversation-view-fixture',
            'production prepared Session'
          );
        else await new Promise((resolve) => setTimeout(resolve, intentLeadMs));
        if (returnAfterMs) {
          await waitFor(() => spare.__targetReady, 'prepared Session before leaving row');
          await source.webContents.executeJavaScript(
            `document.querySelector('[data-sidebar-session-id="session-conversation-view-fixture"]').dispatchEvent(new MouseEvent('pointerout', {bubbles:true}))`
          );
          await new Promise((resolve) => setTimeout(resolve, returnAfterMs));
          if (spare.isDestroyed()) throw new Error('Brief row exit discarded prepared renderer');
        }
        if (
          retargetMode &&
          (spare.isDestroyed() || spare.webContents.getOSProcessId() !== spare.__neighborPid)
        )
          throw new Error('Retarget recreated the prepared renderer');
        if (spare.isVisible()) throw new Error('Speculative window became visible');
        const untouched = await source.webContents.executeJavaScript(`(async () =>
          (await window.repo.getDocMeta('session-session-conversation-view-fixture')).meta.lastReadAt === 0)()`);
        const targetUnread =
          !spare.__preparing ||
          (await spare.webContents.executeJavaScript(`(async () =>
          (await window.repo.getDocMeta('session-session-conversation-view-fixture')).meta.lastReadAt === 0)()`));
        if (!untouched || !targetUnread) throw new Error('Preparation marked Session read');
        log({
          kind: 'speculative-side-effects',
          id: spare.id,
          unreadPreserved: true,
          hidden: true,
        });
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
      const readyAtClick = Boolean(
        spare.__targetReady &&
        (!productPreparedMode ||
          spare.__preparing?.sessionId === 'session-conversation-view-fixture')
      );
      const started = performance.now();
      if (productPreparedMode || directClickMode) spare.__claim = started;
      await source.webContents.executeJavaScript(
        preparedMode
          ? `window.ipc.invoke('app.benchmarkPresent')`
          : productPreparedMode || directClickMode
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
        memory: app.getAppMetrics().map(({ type, memory }) => ({ type, ...memory })),
      });
      heldWindow = null;
      if (process.env.PROBE_KEEP_WINDOWS === '1' && i >= 3) {
        retained.push(spare);
        continue;
      }
      const closed = new Promise((resolve) => spare.once('closed', resolve));
      spare.close();
      await closed;
      if (unloadConfirmations)
        throw new Error('Clean auxiliary window triggered an unload confirmation');
    }
    for (const window of retained) {
      const closed = new Promise((resolve) => window.once('closed', resolve));
      window.close();
      await closed;
    }
    if (unloadConfirmations)
      throw new Error('Clean retained windows triggered unload confirmations');
    let ownerRecovery = null;
    if (process.env.PROBE_OWNER_RECOVERY === '1') {
      const owner = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('session-owner.html')
      );
      if (!owner) throw new Error('Shared owner not running');
      const setup = await source.webContents.executeJavaScript(`(async () => {
        const local = await window.ipc.invoke('localPlatform.getSnapshot');
        const base = { workspaceId: local.workspace.workspaceId, sessionId: 'session-conversation-view-fixture', leaseId: 'recovery-probe' };
        const request = (method, args=[]) => window.ipc.invoke('sessionOwner.request', { ...base, method, args });
        const opened = await request('open'); if (!opened.ok) throw new Error(opened.error);
        const turn = { id: 'recovery-probe-turn', role: 'user', timestamp: '2026-01-01T00:00:00.000Z', items: [{ type: 'text', text: 'Synthetic durable recovery check' }] };
        const written = await request('appendTurn', [turn]); if (!written.ok) throw new Error(written.error);
        return base;
      })()`);
      const started = performance.now();
      owner.webContents.forcefullyCrashRenderer();
      await waitFor(
        () =>
          BrowserWindow.getAllWindows().some(
            (w) => w !== owner && w.webContents.getURL().includes('session-owner.html')
          ),
        'replacement data renderer'
      );
      const recovered = await source.webContents.executeJavaScript(`(async () => {
        const base = { ...${JSON.stringify(setup)}, leaseId: 'recovery-probe-new' };
        const request = (method, args=[]) => window.ipc.invoke('sessionOwner.request', { ...base, method, args });
        const opened = await request('open'); if (!opened.ok) throw new Error(opened.error);
        const read = await request('readTurn', ['recovery-probe-turn']);
        await request('close');
        return read.ok && read.value.state === 'ready';
      })()`);
      if (!recovered) throw new Error('Acknowledged write missing after owner crash');
      await waitFor(
        () =>
          source.webContents.executeJavaScript(
            "document.body.innerText.includes('Synthetic durable recovery check')"
          ),
        'view recovery'
      );
      ownerRecovery = {
        acknowledgedWriteRecovered: recovered,
        viewRecovered: true,
        elapsedMs: performance.now() - started,
      };
    }
    fs.writeFileSync(
      output + '.json',
      JSON.stringify(
        {
          variant: process.env.PROBE_VARIANT,
          sharedSessionOwner: process.env.LODY_SHARED_SESSION_OWNER !== '0',
          unloadConfirmations,
          sourceConversationMs,
          ownerRecovery,
          retargetMode,
          returnAfterMs,
          commandIntent: process.env.PROBE_INTENT_META === '1',
          retainedWindows: retained.length,
          preparedMode,
          productPreparedMode,
          directClickMode,
          nativeAnimationDisabled: !!nativeHost,
          timingBoundary:
            productPreparedMode || directClickMode
              ? 'source row Command-click dispatch'
              : preparedMode
                ? 'prepared host presentation IPC'
                : 'target navigation IPC',
          intentLeadMs,
          hitRate: productPreparedMode
            ? results.filter((r) => !r.warmup && r.readyAtClick).length / repeats
            : preparedMode
              ? 1
              : null,
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
