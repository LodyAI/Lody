import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const policy = {
  locale: 'en-US',
  timezoneId: 'UTC',
  deviceScaleFactor: 1,
  fixedTime: '2026-01-01T12:00:00.000Z',
  randomSeed: 20260101,
  reducedMotion: 'reduce',
  repeats: 2,
  browserLaunchTimeout: 30000,
  browserShutdownTimeout: 15000,
  clientDisconnectTimeout: 5000,
  listenerShutdownTimeout: 5000,
  listenerProbeInterval: 250,
  rawPixelTolerance: 0,
  themeStorage: 'top-level document only',
  serviceWorkers:
    'registration no-op in non-opaque documents; native opaque-origin restrictions retained',
  animationState: 'finite animations finished; infinite animations and SVG SMIL paused at zero',
};
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function argumentsFor(argv) {
  const [mode, ...rest] = argv;
  if (!['baseline', 'verify'].includes(mode))
    throw Error(
      'Usage: accept.mjs baseline|verify --build DIR --profile FILE --out NEW_DIR [--baseline DIR] [--browser FILE]'
    );
  const args = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (
      !['build', 'profile', 'out', 'baseline', 'browser', 'timeout'].includes(key) ||
      !rest[i + 1]
    )
      throw Error(`Invalid argument: ${rest[i]}`);
    if (args[key]) throw Error(`Duplicate argument: --${key}`);
    args[key] = rest[i + 1];
  }
  for (const key of ['build', 'profile', 'out']) if (!args[key]) throw Error(`Missing --${key}`);
  if (mode === 'verify' && !args.baseline)
    throw Error('verify requires --baseline; it never creates or updates a baseline');
  args.timeout = Number(args.timeout ?? 15000);
  if (!Number.isInteger(args.timeout) || args.timeout < 100 || args.timeout > 120000)
    throw Error('timeout must be 100..120000 ms');
  return args;
}

async function inputTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Static inputs must not contain symlinks: ${file}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        files.push([
          path.relative(root, file).split(path.sep).join('/'),
          hash(await readFile(file)),
        ]);
    }
  }
  await walk(root);
  if (!files.length) throw Error('Empty static build');
  return { sha256: hash(json(files)), files };
}

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForListenerClose(endpoint) {
  const { hostname, port } = new URL(endpoint);
  const until = performance.now() + policy.listenerShutdownTimeout;
  while (performance.now() < until) {
    const listening = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: hostname, port: Number(port) });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error) => {
        socket.destroy();
        if (error.code === 'ECONNREFUSED') resolve(false);
        else reject(error);
      });
      socket.setTimeout(Math.max(1, until - performance.now()), () => {
        socket.destroy(Error('Browser listener close timed out'));
      });
    });
    if (!listening) return;
    // Resource shutdown polling is rate-limited to avoid consuming ephemeral ports.
    await new Promise((resolve) => setTimeout(resolve, policy.listenerProbeInterval));
  }
  throw Error('Browser listener remained open after shutdown');
}

async function closeOwnedBrowser(owner, browser) {
  const child = owner.process();
  const errors = [];
  let onExit, onDisconnected;
  let closedOwnedStdio = false;
  const releaseExitedStdio = () => {
    if (child.exitCode === null && child.signalCode === null) return;
    // Chrome has exited; inherited pipes must not delay Playwright's close event.
    for (const stream of child.stdio) {
      if (stream && !stream.destroyed) {
        stream.destroy();
        closedOwnedStdio = true;
      }
    }
  };
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          onExit = () => {
            releaseExitedStdio();
            resolve();
          };
          child.once('exit', onExit);
        });
  const disconnected = !browser?.isConnected()
    ? Promise.resolve()
    : new Promise((resolve) => {
        onDisconnected = resolve;
        browser.once('disconnected', onDisconnected);
      });
  releaseExitedStdio();
  try {
    try {
      // For chromium.connect this disconnects the local client; the server owns Chrome.
      await deadline(
        Promise.race([browser?.close(), disconnected]),
        policy.clientDisconnectTimeout,
        'Browser client disconnect'
      );
    } catch (error) {
      errors.push(error.message);
    }
    try {
      // Native exit alone precedes Playwright's process-close and listener cleanup.
      await deadline(owner.close(), policy.browserShutdownTimeout, 'Browser owner shutdown');
      await deadline(exited, 5000, 'Browser exit confirmation');
    } catch (error) {
      errors.push(error.message);
      // The public owner kills only the process group created by this run.
      try {
        await deadline(owner.kill(), 5000, 'Owned browser forced exit');
      } catch (killError) {
        errors.push(killError.message);
      }
    }
    let listenerClosed = false;
    try {
      await waitForListenerClose(owner.wsEndpoint());
      listenerClosed = true;
    } catch (error) {
      errors.push(error.message);
    }
    return {
      clientDisconnected: !browser?.isConnected(),
      processExitConfirmed: child.exitCode !== null || child.signalCode !== null,
      listenerClosed,
      closedOwnedStdio,
      exitCode: child.exitCode,
      signal: child.signalCode,
      errors,
    };
  } finally {
    if (onExit) child.removeListener('exit', onExit);
    if (onDisconnected) browser.removeListener('disconnected', onDisconnected);
  }
}

async function serve(root) {
  const serveFile = async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      if (!(await stat(canonical)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(canonical).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  };
  const server = createServer((request, response) => {
    void serveFile(request, response).catch((error) => response.destroy(error));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function settle(page, root) {
  await root.waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const visibleImages = [...document.images].filter((image) => {
      const r = image.getBoundingClientRect();
      return (
        r.width && r.height && (image.loading !== 'lazy' || (r.top < innerHeight && r.bottom > 0))
      );
    });
    await Promise.all(visibleImages.map((image) => image.decode()));
    for (const svg of document.querySelectorAll('svg')) {
      svg.pauseAnimations?.();
      svg.setCurrentTime?.(0);
    }
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      } else if (animation.playState !== 'finished') animation.finish();
    }
  });
  // Consecutive animation-frame observations are a readiness signal, not a timed sleep.
  await page.waitForFunction(
    () => {
      const signature = JSON.stringify(
        [...document.body.querySelectorAll('*')]
          .filter((el) => !['SCRIPT', 'STYLE'].includes(el.tagName))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          })
      );
      const previous = window.__visualGeometry;
      window.__visualGeometry = {
        signature,
        matches: previous?.signature === signature ? previous.matches + 1 : 0,
      };
      return window.__visualGeometry.matches >= 2;
    },
    null,
    { polling: 'raf' }
  );
}

async function snapshot(root) {
  return root.evaluate((element) =>
    [element, ...element.querySelectorAll('*')]
      .filter((el) => !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName))
      .map((el) => {
        const r = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return {
          tag: el.tagName,
          text: el.children.length ? '' : el.textContent,
          rect: [r.x, r.y, r.width, r.height],
          css: Object.fromEntries(
            [
              'display',
              'opacity',
              'font-family',
              'font-size',
              'font-weight',
              'line-height',
              'color',
              'background-color',
              'margin',
              'padding',
              'border-radius',
              'box-shadow',
            ].map((key) => [key, style.getPropertyValue(key)])
          ),
        };
      })
  );
}

async function capture(browser, origin, scenario, profile, out, sample, timeout) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    locale: policy.locale,
    timezoneId: policy.timezoneId,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: scenario.theme,
    // Playwright's block init reads a forbidden getter in opaque sandbox frames.
    // The origin-aware init below preserves its registration no-op instead.
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  const errors = [],
    diagnostics = [],
    blocked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' ||
      message.text().startsWith('Service Worker registration blocked by visual acceptance policy:')
    )
      diagnostics.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  context.on('serviceworker', (worker) =>
    errors.push(`Unexpected service worker: ${worker.url()}`)
  );
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === origin)
      return route.continue();
    const declared = (profile.blockedRequests ?? []).some((prefix) => url.startsWith(prefix));
    blocked.push({ url, declared });
    if (!declared) errors.push(`Undeclared external request: ${url}`);
    return route.abort();
  });
  await page.clock.setFixedTime(new Date(policy.fixedTime));
  await context.addInitScript(
    ({ theme, seed }) => {
      if (window === window.top) localStorage.setItem('theme', theme);
      let state = seed;
      Math.random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
      // Opaque sandbox frames already forbid registration, and even accessing
      // their navigator.serviceWorker getter throws. Keep that browser boundary.
      if (window.origin !== 'null' && 'serviceWorker' in navigator) {
        const workers = navigator.serviceWorker;
        if (workers) {
          workers.register = async (scriptURL) => {
            console.warn(
              `Service Worker registration blocked by visual acceptance policy: ${String(scriptURL)}`
            );
          };
        }
      }
    },
    { theme: scenario.theme, seed: policy.randomSeed }
  );
  const stem = `${scenario.id}-${sample}`;
  try {
    const response = await page.goto(origin + scenario.path, { waitUntil: 'load' });
    if (!response?.ok()) throw Error(`Page response ${response?.status()}`);
    const root = page.locator(scenario.root ?? 'body');
    await scenario.ready?.(page);
    await settle(page, root);
    await scenario.act?.(page);
    await scenario.ready?.(page);
    await settle(page, root);
    const before = await snapshot(root);
    const png = await page.screenshot({
      fullPage: scenario.fullPage !== false,
      animations: 'allow',
      caret: 'hide',
    });
    const layout = await snapshot(root);
    let beforeLayout;
    if (json(before) !== json(layout)) {
      beforeLayout = `${stem}-before-screenshot.json`;
      await writeFile(path.join(out, beforeLayout), json(before));
      errors.push(`DOM/layout changed during screenshot; inspect ${beforeLayout} and ${stem}.json`);
    }
    await writeFile(path.join(out, `${stem}.png`), png);
    await writeFile(path.join(out, `${stem}.json`), json(layout));
    return {
      beforeLayout,
      png: `${stem}.png`,
      pngSHA256: hash(png),
      layout: `${stem}.json`,
      layoutSHA256: hash(json(layout)),
      errors,
      diagnostics,
      blocked,
    };
  } catch (error) {
    const errorFile = `${stem}-error.png`;
    let errorPNG;
    try {
      const png = await page.screenshot({ timeout: 2000 });
      await writeFile(path.join(out, errorFile), png);
      errorPNG = errorFile;
    } catch {}
    return { errors: [...errors, error.message], diagnostics, blocked, errorPNG };
  } finally {
    await context.close();
  }
}

async function compare(page, leftSample, rightSample, out, stem) {
  const result = await page.evaluate(
    async ([left, right]) => {
      async function load(source) {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return { canvas, pixels: ctx.getImageData(0, 0, image.width, image.height).data };
      }
      const a = await load(left),
        b = await load(right);
      if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height)
        return {
          dimensions: [
            [a.canvas.width, a.canvas.height],
            [b.canvas.width, b.canvas.height],
          ],
          rawPixels: null,
        };
      const canvas = document.createElement('canvas');
      canvas.width = a.canvas.width;
      canvas.height = a.canvas.height;
      const ctx = canvas.getContext('2d'),
        diff = ctx.createImageData(canvas.width, canvas.height);
      let rawPixels = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        const changed = [0, 1, 2, 3].some(
          (channel) => a.pixels[i + channel] !== b.pixels[i + channel]
        );
        if (changed) rawPixels++;
        diff.data.set(
          changed ? [255, 0, 140, 255] : [a.pixels[i], a.pixels[i + 1], a.pixels[i + 2], 70],
          i
        );
      }
      ctx.putImageData(diff, 0, 0);
      return {
        dimensions: [
          [canvas.width, canvas.height],
          [canvas.width, canvas.height],
        ],
        rawPixels,
        diff: rawPixels ? canvas.toDataURL() : undefined,
      };
    },
    [leftSample.png, rightSample.png]
  );
  const left = JSON.parse(leftSample.layout),
    right = JSON.parse(rightSample.layout);
  let geometryDifferences = 0,
    computedDifferences = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i],
      r = right[i];
    if (!l || !r || json([l.tag, l.text, l.rect]) !== json([r.tag, r.text, r.rect]))
      geometryDifferences++;
    if (json(l?.css) !== json(r?.css)) computedDifferences++;
  }
  if (result.diff) {
    await writeFile(
      path.join(out, `${stem}-diff.png`),
      Buffer.from(result.diff.split(',')[1], 'base64')
    );
    result.diff = `${stem}-diff.png`;
  }
  return {
    ...result,
    geometryDifferences,
    computedDifferences,
    pass: result.rawPixels === 0 && geometryDifferences === 0,
  };
}

async function loadSample(dir, sample) {
  if (!sample?.png || !sample?.layout) throw Error('Missing accepted capture');
  for (const key of ['png', 'layout'])
    if (path.basename(sample[key]) !== sample[key]) throw Error('Invalid evidence filename');
  const png = await readFile(path.join(dir, sample.png)),
    layout = await readFile(path.join(dir, sample.layout));
  if (hash(png) !== sample.pngSHA256 || hash(layout) !== sample.layoutSHA256)
    throw Error('Evidence SHA256 mismatch');
  return { png: `data:image/png;base64,${png.toString('base64')}`, layout: layout.toString() };
}

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
async function report(manifest, out, baselineDir) {
  const cards = [];
  for (const row of manifest.results) {
    const pictures = [];
    for (const [label, dir, file] of [
      ['Before', baselineDir, row.before?.png],
      ['After / sample 1', out, row.samples[0]?.png ?? row.samples[0]?.errorPNG],
      ['Independent sample 2', out, row.samples[1]?.png ?? row.samples[1]?.errorPNG],
      ['Derived pixel difference', out, row.comparison?.diff ?? row.stability?.diff],
    ]) {
      if (dir && file)
        pictures.push(
          `<figure><figcaption>${label}</figcaption><img alt="${escape(row.id)} ${label}" src="data:image/png;base64,${(await readFile(path.join(dir, file))).toString('base64')}"></figure>`
        );
    }
    cards.push(
      `<section><h2>${escape(row.id)} — ${row.pass ? 'PASS' : 'FAIL'}</h2><pre>${escape(json({ stability: row.stability, comparison: row.comparison, errors: row.errors, samples: row.samples.map(({ errors, diagnostics, blocked }) => ({ errors, diagnostics, blocked })) }))}</pre><div class="images">${pictures.join('')}</div></section>`
    );
  }
  await writeFile(
    path.join(out, 'report.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Deterministic visual acceptance</title><style>body{font:14px system-ui;margin:24px;background:#111827;color:#e5e7eb}h1{font-size:24px}section{border-top:1px solid #64748b;margin-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}figure{margin:0;min-width:0}img{max-width:100%;cursor:zoom-in}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}dialog{max-width:95vw;max-height:95vh;padding:8px}dialog img{max-width:none}dialog::backdrop{background:#000b}button{padding:8px}</style><h1>${manifest.pass ? 'PASS' : 'FAIL'} — ${escape(manifest.profileName)}</h1><p>Strict zero raw RGBA pixels and equal geometry/content. Two independent contexts per case. Computed CSS differences are recorded separately. Animation snapshots cover the declared endpoints, not motion equivalence. No baseline auto-update, masks or pixel tolerances.</p><pre>${escape(json({ environment: manifest.environment, policy: manifest.policy, inputs: { runnerSHA256: manifest.runnerSHA256, profileSHA256: manifest.profileSHA256, beforeBuildSHA256: manifest.baselineBuildSHA256, buildSHA256: manifest.build?.sha256 }, errors: manifest.errors, cleanup: manifest.cleanup }))}</pre>${cards.join('')}<dialog><button autofocus>Close</button><div><img alt="Original real browser screenshot"></div></dialog><script>const dialog=document.querySelector('dialog'),original=dialog.querySelector('img');document.querySelectorAll('figure img').forEach(img=>{img.tabIndex=0;const open=()=>{original.src=img.src;dialog.showModal()};img.onclick=open;img.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}}});dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>original.removeAttribute('src'));</script></html>`
  );
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const requestedOut = path.resolve(args.out);
  const out = path.join(await realpath(path.dirname(requestedOut)), path.basename(requestedOut)),
    build = await realpath(args.build),
    profilePath = await realpath(args.profile);
  if (out === build || out.startsWith(build + path.sep))
    throw Error('Output must be outside the immutable static build');
  await mkdir(out); // Refuse to overwrite evidence, including failed runs.
  const manifest = { schema: 1, mode: args.mode, pass: false, policy, results: [], errors: [] };
  let browser, browserOwner, server;
  try {
    const profile = (await import(pathToFileURL(profilePath))).default;
    if (!profile?.scenarios?.length) throw Error('Profile must contain scenarios');
    const ids = new Set();
    for (const scenario of profile.scenarios) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(scenario.id) || ids.has(scenario.id))
        throw Error(`Invalid or duplicate scenario id: ${scenario.id}`);
      ids.add(scenario.id);
      if (
        !scenario.path.startsWith('/') ||
        scenario.path.startsWith('//') ||
        !['light', 'dark'].includes(scenario.theme) ||
        !Number.isInteger(scenario.viewport?.width) ||
        !Number.isInteger(scenario.viewport?.height)
      )
        throw Error(`Invalid scenario: ${scenario.id}`);
    }
    manifest.profileName = profile.name;
    manifest.profileSHA256 = hash(await readFile(profilePath));
    manifest.runnerSHA256 = hash(await readFile(fileURLToPath(import.meta.url)));
    manifest.build = await inputTree(build);
    const executable = await realpath(
      args.browser ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath()
    );
    browserOwner = await chromium.launchServer({
      host: '127.0.0.1',
      executablePath: executable,
      headless: true,
      args: ['--force-color-profile=srgb', '--disable-gpu'],
      timeout: policy.browserLaunchTimeout,
    });
    manifest.resources = {
      browserPID: browserOwner.process().pid,
      browserPort: Number(new URL(browserOwner.wsEndpoint()).port),
    };
    browser = await chromium.connect(browserOwner.wsEndpoint(), {
      timeout: policy.browserLaunchTimeout,
    });
    manifest.environment = {
      browserVersion: browser.version(),
      playwrightVersion: createRequire(import.meta.url)('@playwright/test/package.json').version,
      executableSHA256: hash(await readFile(executable)),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      node: process.versions.node,
    };
    let baseline;
    if (args.mode === 'verify') {
      baseline = JSON.parse(await readFile(path.join(args.baseline, 'manifest.json'), 'utf8'));
      if (baseline.schema !== 1 || baseline.mode !== 'baseline' || !baseline.pass)
        throw Error('Baseline is not a successful baseline run');
      for (const key of ['environment', 'policy', 'profileSHA256', 'runnerSHA256'])
        if (json(baseline[key]) !== json(manifest[key]))
          throw Error(`Baseline ${key} differs; use the same browser/OS/Node/profile/policy`);
      if (
        json(baseline.results.map((row) => row.id)) !==
        json(profile.scenarios.map((scenario) => scenario.id))
      )
        throw Error('Baseline cases differ');
      manifest.baselineBuildSHA256 = baseline.build.sha256;
      for (const row of baseline.results)
        for (const sample of row.samples) await loadSample(args.baseline, sample);
    }
    server = await serve(build);
    manifest.resources.staticPort = Number(new URL(server.origin).port);
    const comparePage = await browser.newPage();
    for (const scenario of profile.scenarios) {
      const row = { id: scenario.id, pass: false, samples: [], errors: [] };
      manifest.results.push(row);
      for (let repeat = 1; repeat <= policy.repeats; repeat++)
        row.samples.push(
          await capture(browser, server.origin, scenario, profile, out, repeat, args.timeout)
        );
      try {
        if (row.samples.some((sample) => sample.errors.length))
          throw Error('Capture failed; inspect both samples');
        const samples = await Promise.all(row.samples.map((sample) => loadSample(out, sample)));
        row.stability = await compare(
          comparePage,
          samples[0],
          samples[1],
          out,
          `${row.id}-stability`
        );
        if (baseline) {
          row.before = baseline.results.find((entry) => entry.id === row.id).samples[0];
          row.comparison = await compare(
            comparePage,
            await loadSample(args.baseline, row.before),
            samples[0],
            out,
            `${row.id}-comparison`
          );
        }
        row.pass = row.stability.pass && (!baseline || row.comparison.pass);
      } catch (error) {
        row.errors.push(error.message);
      }
      console.log(
        `${row.pass ? 'PASS' : 'FAIL'} ${row.id}${row.comparison ? ` raw=${row.comparison.rawPixels} geometry=${row.comparison.geometryDifferences}` : ''}`
      );
      await writeFile(path.join(out, 'manifest.json'), json(manifest));
    }
    if ((await inputTree(build)).sha256 !== manifest.build.sha256)
      throw Error('Static build changed during capture');
    if (hash(await readFile(profilePath)) !== manifest.profileSHA256)
      throw Error('Profile changed during capture');
    manifest.pass = manifest.results.every((row) => row.pass);
  } catch (error) {
    manifest.errors.push(error.stack ?? error.message);
  } finally {
    try {
      if (browserOwner) {
        manifest.cleanup = await closeOwnedBrowser(browserOwner, browser);
        if (manifest.cleanup.errors.length) {
          manifest.errors.push(
            ...manifest.cleanup.errors.map((error) => `Browser cleanup: ${error}`)
          );
          manifest.pass = false;
        }
      }
    } catch (error) {
      manifest.errors.push(`Browser cleanup: ${error.message}`);
      manifest.pass = false;
    }
    try {
      await server?.close();
    } catch (error) {
      manifest.errors.push(`Server cleanup: ${error.message}`);
      manifest.pass = false;
    }
    await writeFile(path.join(out, 'manifest.json'), json(manifest));
    await report(manifest, out, args.baseline);
  }
  console.log(`${manifest.pass ? 'PASS' : 'FAIL'}: ${path.join(out, 'report.html')}`);
  process.exitCode = manifest.pass ? 0 : 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
