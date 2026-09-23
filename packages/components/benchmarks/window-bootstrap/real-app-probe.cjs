const { app, BrowserWindow } = require('electron');
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
const records = [];
const log = (x) => {
  records.push(x);
  fs.appendFileSync(output + '.jsonl', JSON.stringify(x) + '\n');
};
let running = null;
app.on('browser-window-created', (_createdEvent, win) => {
  win.__created = performance.now();
  const wc = win.webContents;
  const send = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    if (channel === 'app.windowTarget') {
      win.__claim = performance.now();
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
  wc.on('ipc-message', (_, channel) => {
    if (channel === 'app.windowReady') win.__shellReady = true;
  });
  wc.on('console-message', (_, level, message) => {
    if (message.startsWith('RuntimeProvider:'))
      log({ kind: 'runtime', id: win.id, message, at: performance.now() });
  });
  win.on('show', async () => {
    if (!win.__claim) return;
    const claimToShowMs = performance.now() - win.__claim;
    const capture = wc.capturePage();
    const state = await wc.executeJavaScript(
      `({ready:!!document.querySelector('[data-window-session-ready]'),answer:document.body.innerText.includes('Answer for round 1499.'),loading:document.body.innerText.includes('Loading'),missing:document.body.innerText.includes('Session not found'),streamVisible:(()=>{const e=document.querySelector('[data-message-selection-scroll]');return !!e && getComputedStyle(e).visibility==='visible'})()})`
    );
    const screenshot = output + '-' + win.id + '.png';
    fs.writeFileSync(screenshot, (await capture).toPNG());
    const row = { kind: 'shown', id: win.id, claimToShowMs, state, screenshot };
    log(row);
    running?.resolve(row);
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
app.whenReady().then(async () => {
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
    const binary = fs.readFileSync(process.env.PROBE_FIXTURE, 'utf8');
    await source.webContents.executeJavaScript(`(async()=>{
 const repo=window.repo;const machine=(await repo.listDoc()).find(x=>x.docId.startsWith('machine-')).meta;
 const sessionId='session-conversation-view-fixture';const room='session-'+sessionId;
 const handle=await repo.acquireDoc(room);window.__syntheticSession=handle;
 handle.doc.import(Uint8Array.from(atob(${JSON.stringify(binary)}),x=>x.charCodeAt(0)));
 await repo.upsertDocMeta(room,{id:sessionId,machineId:machine.id,userId:machine.ownerUserId,createdAt:new Date().toISOString(),lastMessageAt:Date.now(),title:'Warm window benchmark — synthetic 3000 entries',status:'idle',cliType:'builtin',agentType:'claude',isArchived:false});
 await repo.flush();location.hash='/local/sessions/'+sessionId;
 })()`);
    await waitFor(
      () =>
        source.webContents.executeJavaScript(
          `!!document.querySelector('[data-window-session-ready]') && document.body.innerText.includes('Answer for round 1499.')`
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
      const shown = new Promise((resolve, reject) => {
        running = { resolve, reject };
      });
      const timeout = setTimeout(() => running?.reject(new Error('No show')), 10000);
      const started = performance.now();
      await source.webContents.executeJavaScript(
        `window.ipc.invoke('app.openWindow',{workspace:'local',sessionId:'session-conversation-view-fixture'})`
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
      results.push({
        ...row,
        prepared,
        requestToCaptureMs: performance.now() - started,
        warmup: i < 3,
      });
      const closed = new Promise((resolve) => spare.once('closed', resolve));
      spare.close();
      await closed;
    }
    fs.writeFileSync(
      output + '.json',
      JSON.stringify(
        {
          variant: process.env.PROBE_VARIANT,
          entries: 3000,
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
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
