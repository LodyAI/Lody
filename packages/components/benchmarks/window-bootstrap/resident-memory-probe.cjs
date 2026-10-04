const { app, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

// Sampling intervals measure natural idle residency; they are not test synchronization.
module.exports = async function residentMemoryProbe({ source, answer, waitFor, log }) {
  if (process.platform !== 'darwin') throw new Error('Resident footprint probe requires macOS');
  const sessionId = 'session-conversation-view-fixture';
  const stages = [];
  const auxiliaries = [];
  const invoke = (method, ...args) =>
    source.webContents.executeJavaScript(
      `window.ipc.invoke(${JSON.stringify(method)},...${JSON.stringify(args)})`
    );
  const isOwner = (win) => win.webContents.getURL().includes('session-owner.html');
  const productPeers = () =>
    BrowserWindow.getAllWindows().filter((w) => w !== source && !isOwner(w));

  async function sample(stage, offsetMs, includeHeap) {
    const windows = BrowserWindow.getAllWindows();
    const metrics = app.getAppMetrics().map(({ pid, type, memory }) => {
      const win = windows.find((w) => w.webContents.getOSProcessId() === pid);
      const role = win
        ? win === source
          ? 'source'
          : isOwner(win)
            ? 'owner'
            : win.isVisible()
              ? 'auxiliary'
              : win.__targetReady
                ? 'prepared'
                : 'shell'
        : type;
      return { pid, role, windowId: win?.id ?? null, workingSetKiB: memory.workingSetSize };
    });
    const { stdout } = await run(
      process.env.PROBE_MEMORY_SAMPLER,
      metrics.map(({ pid }) => String(pid))
    );
    const footprint = JSON.parse(stdout);
    const exitedPids = [];
    for (const metric of metrics) {
      const captured = footprint.find((p) => p.pid === metric.pid);
      if (!captured) throw new Error('Missing process counter: ' + metric.pid);
      if (captured.exited) {
        exitedPids.push(metric.pid);
        continue;
      }
      metric.physFootprintBytes = captured.physFootprintBytes;
      if (includeHeap && metric.windowId !== null) {
        const wc = BrowserWindow.fromId(metric.windowId)?.webContents;
        if (!wc) throw new Error('Window disappeared during resident sample');
        wc.debugger.attach('1.3');
        try {
          metric.heap = await wc.debugger.sendCommand('Runtime.getHeapUsage');
        } finally {
          wc.debugger.detach();
        }
      }
    }
    const capturedMetrics = metrics.filter((p) => !exitedPids.includes(p.pid));
    const value = {
      offsetMs,
      processes: capturedMetrics,
      exitedPids,
      physFootprintMiB: capturedMetrics.reduce((sum, p) => sum + p.physFootprintBytes, 0) / 1048576,
      workingSetMiB: capturedMetrics.reduce((sum, p) => sum + p.workingSetKiB, 0) / 1024,
      sampler: 'proc_pid_rusage',
    };
    log({ kind: 'resident-memory', stage, ...value });
    return value;
  }

  async function observe(name, offsets = [0, 2000, 5000, 10000], beforeSample) {
    const started = performance.now();
    const samples = [];
    for (const offset of offsets) {
      const delay = offset - (performance.now() - started);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      await beforeSample?.();
      samples.push(await sample(name, offset, offset === offsets.at(-1)));
    }
    stages.push({ name, samples });
  }

  await invoke('app.setWindowWarmup', false);
  await waitFor(() => productPeers().length === 0, 'no initial warm window');
  await observe('source-only', [0, 10000, 30000, 45000]);
  await invoke('app.setWindowWarmup', true);
  const shell = await waitFor(
    () => productPeers().find((w) => !w.isVisible() && w.__shellReady),
    'resident neutral shell'
  );
  await observe('neutral-shell');
  source.focus();
  await invoke('app.prepareWindow', { workspace: 'local', sessionId }, 'resident-probe');
  await waitFor(() => shell.__targetReady, 'resident prepared content');
  if (shell.isVisible()) throw new Error('Prepared window became visible');
  await observe('prepared-target', [0, 10000, 20000, 30000, 45000], () =>
    invoke('app.prepareWindow', { workspace: 'local', sessionId }, crypto.randomUUID())
  );
  const preparedPid = shell.webContents.getOSProcessId();
  await invoke('app.setWindowWarmup', false);
  await waitFor(() => productPeers().length === 0, 'prepared window disposed');
  await waitFor(
    () => !app.getAppMetrics().some((p) => p.pid === preparedPid),
    'prepared renderer exited'
  );
  await observe('after-preparation-disabled');

  for (let index = 1; index <= 5; index++) {
    const known = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
    await invoke('app.openWindow', { workspace: 'local', sessionId });
    const win = await waitFor(
      () => productPeers().find((w) => !known.has(w.id) && w.isVisible()),
      'resident visible auxiliary'
    );
    await waitFor(
      () =>
        win.webContents.executeJavaScript(
          `!!document.querySelector('[data-window-session-stream-ready="${sessionId}"]') && document.body.innerText.includes(${JSON.stringify(answer)})`
        ),
      'resident auxiliary content'
    );
    auxiliaries.push(win);
    if ([1, 3, 5].includes(index)) await observe(`auxiliary-${index}`);
  }
  const auxiliaryPids = new Set(auxiliaries.map((win) => win.webContents.getOSProcessId()));
  for (const win of auxiliaries) {
    const closed = new Promise((resolve) => win.once('closed', resolve));
    win.close();
    await closed;
  }
  await waitFor(() => productPeers().length === 0, 'all auxiliaries destroyed');
  await waitFor(
    () => !app.getAppMetrics().some((p) => auxiliaryPids.has(p.pid)),
    'auxiliary renderers exited'
  );
  await observe('after-all-closed', [0, 2000, 10000, 30000]);
  return {
    scope: 'Electron app.getAppMetrics process set; external CLI/daemon processes excluded',
    metric:
      'Sum of macOS footprint auxiliary.phys_footprint bytes; working sets retained separately',
    forcedGC: false,
    stages,
  };
};
