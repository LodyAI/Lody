import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { promisify } from 'node:util';
import { test } from 'node:test';

const runFile = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// These are intentionally synthetic runner fixtures, not product acceptance images.
await test(
  'real-browser acceptance rejects pixel, geometry, readiness, evidence and repeatability failures',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(packageRoot, 'artifacts/visual/accept-harness-'));
    const build = path.join(root, 'build');
    await mkdir(build);
    const html = (offset = 0, hiddenOffset = 0) =>
      `<!doctype html><html><meta charset="utf-8"><body style="margin:0;font:16px monospace"><main style="width:160px;height:80px;background:#123456;position:relative;left:${offset}px">Visual fixture<span style="opacity:0;position:absolute;left:${hiddenOffset}px">geometry</span></main></body></html>`;
    await writeFile(path.join(build, 'index.html'), html());
    const profile = path.join(root, 'profile.mjs');
    const scenario = `{id:'fixture',path:'/',theme:'light',viewport:{width:320,height:200},root:'main'}`;
    await writeFile(profile, `export default {name:'fixture',scenarios:[${scenario}]};`);
    const baseline = path.join(root, 'baseline');
    async function run(mode, outName, extras = [], profileFile = profile) {
      const out = path.join(root, outName);
      const args = [
        'tests/visual/accept.mjs',
        mode,
        '--build',
        build,
        '--profile',
        profileFile,
        '--out',
        out,
        '--timeout',
        '1000',
        ...extras,
      ];
      let result;
      try {
        result = {
          code: 0,
          ...(await runFile(process.execPath, args, {
            cwd: packageRoot,
            timeout: 30000,
            env: process.env,
          })),
        };
      } catch (error) {
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      await writeFile(
        path.join(root, `${outName}.log`),
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      );
      return {
        ...result,
        out,
        manifest: await readFile(path.join(out, 'manifest.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => undefined),
      };
    }
    const first = await run('baseline', 'baseline');
    assert.equal(first.code, 0, JSON.stringify(first));
    await t.test('identical immutable build passes strict comparison', async () => {
      const result = await run('verify', 'identical', ['--baseline', baseline]);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.manifest.results[0].comparison.rawPixels, 0);
      assert.equal(result.manifest.results[0].comparison.geometryDifferences, 0);
      const browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true,
      });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(pathToFileURL(path.join(result.out, 'report.html')).href);
        assert.equal(await page.locator('figure img').count(), 3);
        await page
          .locator('figure img')
          .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        );
        await page.locator('figure img').first().focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('dialog').evaluate((dialog) => dialog.open), true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () =>
            !document.querySelector('dialog').open &&
            !document.querySelector('dialog img').hasAttribute('src')
        );
        assert.equal(
          await page.locator('dialog img').evaluate((image) => image.hasAttribute('src')),
          false
        );
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
    await t.test('existing evidence directories are never overwritten', async () => {
      const original = await readFile(path.join(baseline, 'manifest.json'));
      const result = await run('baseline', 'baseline');
      assert.equal(result.code, 1);
      assert.deepEqual(await readFile(path.join(baseline, 'manifest.json')), original);
    });
    await t.test('one-pixel displacement fails without a pixel tolerance', async () => {
      await writeFile(path.join(build, 'index.html'), html(1));
      const result = await run('verify', 'pixel-change', ['--baseline', baseline]);
      assert.equal(result.code, 1);
      assert.ok(result.manifest.results[0].comparison.rawPixels > 0);
      assert.ok(result.manifest.results[0].comparison.diff);
    });
    await t.test('a single-channel color change fails with identical geometry', async () => {
      await writeFile(path.join(build, 'index.html'), html().replace('#123456', '#123457'));
      const result = await run('verify', 'one-channel-change', ['--baseline', baseline]);
      assert.equal(result.code, 1);
      assert.ok(result.manifest.results[0].comparison.rawPixels > 0);
      assert.equal(result.manifest.results[0].comparison.geometryDifferences, 0);
    });
    await t.test('invisible geometry change fails even when pixels match', async () => {
      await writeFile(path.join(build, 'index.html'), html(0, 1));
      const result = await run('verify', 'geometry-change', ['--baseline', baseline]);
      assert.equal(result.code, 1);
      assert.equal(result.manifest.results[0].comparison.rawPixels, 0);
      assert.ok(result.manifest.results[0].comparison.geometryDifferences > 0);
    });
    await writeFile(path.join(build, 'index.html'), html());
    await t.test(
      'two independent captures must agree; unstable baselines cannot be used',
      async () => {
        const unstable = path.join(root, 'unstable.mjs');
        await writeFile(
          unstable,
          `let count=0;export default {name:'unstable',scenarios:[{...${scenario},act:async(page)=>{await page.locator('main').evaluate((el,n)=>el.firstChild.textContent=String(n),++count)}}]};`
        );
        const result = await run('baseline', 'unstable', [], unstable);
        assert.equal(result.code, 1);
        assert.ok(result.manifest.results[0].stability.rawPixels > 0);
        const verify = await run('verify', 'reject-unstable', ['--baseline', result.out], unstable);
        assert.equal(verify.code, 1);
        assert.match(verify.manifest.errors.join(), /not a successful baseline/);
      }
    );
    await t.test(
      'failed readiness preserves failure evidence and never accepts a frame',
      async () => {
        const waiting = path.join(root, 'waiting.mjs');
        await writeFile(
          waiting,
          `export default {name:'waiting',scenarios:[{...${scenario},ready:page=>page.locator('#never-created').waitFor()}]};`
        );
        const result = await run('baseline', 'waiting', [], waiting);
        assert.equal(result.code, 1);
        assert.equal(result.manifest.results[0].samples[0].png, undefined);
        assert.ok(result.manifest.results[0].samples[0].errorPNG);
      }
    );
    await t.test('tampered baseline screenshot is rejected by digest', async () => {
      const tampered = path.join(root, 'tampered');
      await cp(baseline, tampered, { recursive: true });
      await writeFile(
        path.join(tampered, first.manifest.results[0].samples[0].png),
        'not the original PNG'
      );
      const result = await run('verify', 'reject-tampered', ['--baseline', tampered]);
      assert.equal(result.code, 1);
      assert.match(result.manifest.errors.join(), /SHA256 mismatch/);
    });
    await t.test('browser environment changes refuse comparison', async () => {
      const different = path.join(root, 'different-environment');
      await cp(baseline, different, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(different, 'manifest.json'), 'utf8'));
      manifest.environment.browserVersion = 'different-browser';
      await writeFile(path.join(different, 'manifest.json'), JSON.stringify(manifest));
      const result = await run('verify', 'reject-environment', ['--baseline', different]);
      assert.equal(result.code, 1);
      assert.match(result.manifest.errors.join(), /environment differs/);
    });
    await t.test('unexpected external dependencies fail and are recorded', async () => {
      await writeFile(
        path.join(build, 'index.html'),
        html() + '<script src="https://visual-test.invalid/unavailable.js"></script>'
      );
      const result = await run('baseline', 'external-request');
      assert.equal(result.code, 1);
      assert.ok(
        result.manifest.results[0].samples[0].blocked.some((request) => request.declared === false)
      );
      await writeFile(path.join(build, 'index.html'), html());
    });
    const policyHTML =
      '<!doctype html><html><body style="margin:0;font:16px Arial,sans-serif;line-height:20px"><main style="width:160px;height:80px;background:#123456">Browser policy fixture</main></body></html>';
    await t.test(
      'opaque sandbox frames retain restrictions without automation pageerrors',
      async () => {
        const sandboxed = path.join(root, 'sandboxed.mjs');
        const child =
          "<p>Isolated preview</p><script>parent.postMessage('sandbox-ready','*')</script>";
        await writeFile(
          path.join(build, 'index.html'),
          policyHTML +
            `<script>window.addEventListener('message',e=>{if(e.data==='sandbox-ready')window.sandboxReady=true})</script><iframe title="Isolated preview" sandbox="allow-scripts" srcdoc="${child}"></iframe>`
        );
        await writeFile(
          sandboxed,
          `export default {name:'opaque-sandbox',scenarios:[{...${scenario},ready:page=>page.waitForFunction(()=>window.sandboxReady===true),act:async page=>{const frame=page.frames().find(frame=>frame!==page.mainFrame());const origin=await frame.evaluate(()=>window.origin);if(origin!=='null')throw Error('Sandbox origin changed');let denied=false;try{await frame.evaluate(()=>localStorage.getItem('theme'))}catch(error){denied=error.message.includes('sandboxed')}if(!denied)throw Error('Sandbox storage restriction removed');const theme=await page.evaluate(()=>localStorage.getItem('theme'));if(theme!=='light')throw Error('Top-level theme was not initialized')}}]};`
        );
        const result = await run('baseline', 'opaque-sandbox', [], sandboxed);
        assert.equal(result.code, 0, JSON.stringify(result.manifest));
        for (const sample of result.manifest.results[0].samples)
          assert.deepEqual(sample.errors, []);
        await writeFile(path.join(build, 'index.html'), html());
      }
    );
    await t.test(
      'service-worker registrations remain blocked without fetching or executing a worker',
      async () => {
        const workerProfile = path.join(root, 'worker-blocked.mjs');
        await writeFile(path.join(build, 'index.html'), policyHTML);
        await writeFile(
          path.join(build, 'worker.js'),
          "self.addEventListener('activate',event=>event.waitUntil(fetch('/worker-executed.txt')));"
        );
        await writeFile(
          workerProfile,
          `export default {name:'worker-blocked',scenarios:[{...${scenario},act:async page=>{const requests=[];page.context().on('request',request=>requests.push(new URL(request.url()).pathname));const result=await page.evaluate(async()=>({blocked:await navigator.serviceWorker.register('/worker.js')===undefined,registrations:(await navigator.serviceWorker.getRegistrations()).length}));if(!result.blocked||result.registrations!==0||page.context().serviceWorkers().length!==0||requests.includes('/worker.js')||requests.includes('/worker-executed.txt'))throw Error('Worker registration/fetch/execution escaped the visual policy')}}]};`
        );
        const result = await run('baseline', 'worker-blocked', [], workerProfile);
        assert.equal(result.code, 0, JSON.stringify(result.manifest));
        for (const sample of result.manifest.results[0].samples) {
          assert.ok(
            sample.diagnostics.some((message) =>
              message.includes(
                'Service Worker registration blocked by visual acceptance policy: /worker.js'
              )
            )
          );
          assert.deepEqual(sample.errors, []);
        }
        await writeFile(path.join(build, 'index.html'), html());
      }
    );
    await t.test('real sandbox application errors are still capture failures', async () => {
      const sandboxed = path.join(root, 'sandbox-product-error.mjs');
      const child =
        "<p>Isolated preview</p><script>parent.postMessage('sandbox-ready','*');localStorage.getItem('product-owned-access')</script>";
      await writeFile(
        path.join(build, 'index.html'),
        policyHTML +
          `<script>window.addEventListener('message',e=>{if(e.data==='sandbox-ready')window.sandboxReady=true})</script><iframe title="Isolated preview" sandbox="allow-scripts" srcdoc="${child}"></iframe>`
      );
      await writeFile(
        sandboxed,
        `export default {name:'opaque-product-error',scenarios:[{...${scenario},ready:page=>page.waitForFunction(()=>window.sandboxReady===true)}]};`
      );
      const result = await run('baseline', 'opaque-product-error', [], sandboxed);
      assert.equal(result.code, 1);
      for (const sample of result.manifest.results[0].samples) {
        assert.ok(
          sample.errors.some(
            (message) => message.includes("'localStorage'") && message.includes('sandboxed')
          )
        );
        assert.equal(sample.png !== undefined, true);
      }
      await writeFile(path.join(build, 'index.html'), html());
    });
    await t.test('build mutation cannot produce an accepted baseline', async () => {
      const changing = path.join(root, 'changing.mjs');
      const marker = path.join(build, 'mutation.txt');
      await writeFile(
        changing,
        `import {writeFile} from 'node:fs/promises';export default {name:'changing',scenarios:[{...${scenario},act:()=>writeFile(${JSON.stringify(marker)},'changed during capture')}]};`
      );
      const result = await run('baseline', 'build-mutated', [], changing);
      assert.equal(result.code, 1);
      assert.equal(result.manifest.results[0].stability.rawPixels, 0);
      assert.match(result.manifest.errors.join(), /build changed during capture/);
    });
    await t.test(
      'shutdown confirms owned process exit without waiting on a client close receipt',
      async () => {
        const lostReceipt = path.join(root, 'lost-close-receipt.mjs');
        await writeFile(
          lostReceipt,
          `export default {name:'lost-close-receipt',scenarios:[{...${scenario},act:async(page)=>{const browser=page.context().browser();const close=browser.close.bind(browser);browser.close=async()=>{await close();return new Promise(()=>{});};}}]};`
        );
        const result = await run('baseline', 'lost-close-receipt', [], lostReceipt);
        assert.equal(result.code, 0, JSON.stringify(result.manifest));
        assert.equal(result.manifest.cleanup.processExitConfirmed, true);
        assert.equal(result.manifest.cleanup.exitCode, 0);
        assert.deepEqual(result.manifest.errors, []);
      }
    );
    await t.test(
      'spawned acceptance exits after releasing both browser and static listeners',
      async () => {
        const multi = path.join(root, 'multiple-contexts.mjs');
        await writeFile(
          multi,
          `export default {name:'multiple-contexts',scenarios:Array.from({length:4},(_,index)=>({...${scenario},id:'fixture-'+index}))};`
        );
        const result = await run('baseline', 'multiple-contexts', [], multi);
        assert.equal(result.code, 0, JSON.stringify(result.manifest));
        assert.equal(result.manifest.cleanup.clientDisconnected, true);
        assert.equal(result.manifest.cleanup.processExitConfirmed, true);
        assert.equal(result.manifest.cleanup.listenerClosed, true);
        for (const port of [
          result.manifest.resources.browserPort,
          result.manifest.resources.staticPort,
        ]) {
          await assert.rejects(
            new Promise((resolve, reject) => {
              const socket = createConnection({ host: '127.0.0.1', port });
              socket.once('connect', () => {
                socket.destroy();
                resolve();
              });
              socket.once('error', (error) => {
                socket.destroy();
                reject(error);
              });
            }),
            { code: 'ECONNREFUSED' }
          );
        }
      }
    );
    await t.test('symlink aliases cannot place output inside immutable inputs', async () => {
      const alias = path.join(root, 'build-alias');
      await symlink(build, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const output = path.join(alias, 'must-not-exist');
      await assert.rejects(
        runFile(
          process.execPath,
          [
            'tests/visual/accept.mjs',
            'baseline',
            '--build',
            build,
            '--profile',
            profile,
            '--out',
            output,
          ],
          { cwd: packageRoot, env: process.env }
        ),
        (error) => error.code === 1 && error.stderr.includes('outside the immutable static build')
      );
      await assert.rejects(stat(path.join(build, 'must-not-exist')), { code: 'ENOENT' });
    });
    console.log(`Runner negative-control evidence: ${root}`);
  }
);
