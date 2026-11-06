import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { promisify } from 'node:util';
import { test } from 'node:test';

const runFile = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// These are intentionally synthetic runner fixtures, not product acceptance images.
test(
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
