/**
 * Visual regression harness for the Tailwind -> StyleX migration.
 *
 * `capture` renders Storybook stories in a real browser and stores a screenshot
 * plus a layout snapshot for every (story, viewport, theme) triple.
 * `report` compares two captures, writes the difference images and builds a
 * self-contained HTML report.
 *
 * Everything here is real rendering: a Chromium page loads the story, the
 * browser lays it out and paints it, and the screenshot is that frame. No mock,
 * no generated image.
 *
 *   node tests/visual/visual-regression.mjs capture --phase before
 *   node tests/visual/visual-regression.mjs capture --phase after
 *   node tests/visual/visual-regression.mjs report --before before --after after
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../..');
const artifactsRoot = path.resolve(packageRoot, 'artifacts/visual');

const DEFAULT_STORYBOOK = process.env.LODY_STORYBOOK_URL ?? 'http://127.0.0.1:6006';

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function readTargets(file) {
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw);
}

/** Every story whose title starts with one of the configured prefixes. */
function selectStories(index, targets, only) {
  const prefixes = targets.titles ?? [];
  const entries = Object.values(index.entries ?? {});
  return entries
    .filter((entry) => entry.type === 'story')
    .filter((entry) => {
      if (!prefixes.length) return true;
      return prefixes.some((prefix) => entry.title === prefix || entry.title.startsWith(prefix));
    })
    .filter((entry) => !only || entry.id.includes(only) || entry.title.includes(only))
    .filter((entry) => !targets.ids || targets.ids.includes(entry.id))
    .filter((entry) => !targets.excludeIds?.includes(entry.id))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function storyUrl(baseUrl, storyId, theme, locale) {
  const url = new URL('/iframe.html', baseUrl);
  url.searchParams.set('id', storyId);
  url.searchParams.set('viewMode', 'story');
  url.searchParams.set('globals', `theme:${theme};locale:${locale}`);
  return url.toString();
}

/**
 * A layout snapshot of everything the story rendered: the box each element
 * occupies and the text properties a migration can move. Keyed by the element's
 * path from the story root, so a style change shows up as a moved box and a
 * structural change shows up as a missing path.
 */
const LAYOUT_SNAPSHOT = () => {
  // Include portalled dialogs, menus and tooltips outside the story root.
  const root = document.body;
  const rows = [];
  const walk = (element, pathParts) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    rows.push({
      path: pathParts.join('>'),
      tag: element.tagName.toLowerCase(),
      rect: [
        Math.round(rect.x * 100) / 100,
        Math.round(rect.y * 100) / 100,
        Math.round(rect.width * 100) / 100,
        Math.round(rect.height * 100) / 100,
      ],
      text: (element.textContent ?? '').trim().slice(0, 60),
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      opacity: style.opacity,
    });
    Array.from(element.children).forEach((child, index) => {
      walk(child, [...pathParts, String(index)]);
    });
  };
  Array.from(root.children)
    .filter(
      (child) =>
        child.id === 'storybook-root' ||
        (!['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName) &&
          !child.className?.toString().includes('sb-'))
    )
    .forEach((child, index) => walk(child, [String(index)]));
  return rows;
};

/**
 * Launch Chromium.
 *
 * Playwright pins a browser revision, and a machine may carry another one from
 * an earlier install. When the pinned build is missing, fall back to the newest
 * Chromium already in the Playwright cache — the harness needs a real browser,
 * not a particular build of it.
 */
async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = [];
    if (existsSync(cacheRoot)) {
      for (const entry of await readdir(cacheRoot)) {
        const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
        if (!match) continue;
        const shell = path.join(
          cacheRoot,
          entry,
          'chrome-headless-shell-mac-arm64/chrome-headless-shell'
        );
        if (existsSync(shell)) candidates.push({ shell, revision: Number(match[1]) });
      }
    }
    candidates.sort((left, right) => right.revision - left.revision);
    if (!candidates.length) throw error;
    return await chromium.launch({ executablePath: candidates[0].shell });
  }
}

/**
 * Wait until the story has actually painted.
 *
 * Storybook renders the story into `#storybook-root`; while it loads, that
 * root holds a spinner, and a page that is captured then shows the spinner
 * rather than the component. Wait for the root to have content, then for its
 * markup to stop changing — a story that renders in two passes (a font
 * arriving, an effect settling) would otherwise be captured mid-pass.
 */
async function waitForStory(page, allowBlank = false) {
  await page.waitForFunction(
    () => {
      const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase;
      if (document.body.classList.contains('sb-show-errordisplay')) {
        throw new Error(
          document.getElementById('error-message')?.textContent || 'Storybook render error'
        );
      }
      return (
        phase === 'finished' && document.getElementById('storybook-root')?.childElementCount > 0
      );
    },
    undefined,
    { timeout: 45_000 }
  );
  await page.evaluate(() => document.fonts.ready);
  await waitForImages(page);
  await settleLayout(page);
  if (!allowBlank) await waitForVisibleContent(page);
}

const VISIBLE_CONTENT = () => {
  const root = document.getElementById('storybook-root');
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return (
      rect.width > 0 && rect.height > 0 && css.visibility !== 'hidden' && css.display !== 'none'
    );
  };
  if (!root) return false;
  if (root.innerText.trim()) return true;
  return [...root.querySelectorAll('button,input,textarea,h1,h2,h3,p,span,svg,img,canvas')].some(
    (element) =>
      visible(element) &&
      (element.innerText?.trim() ||
        ['INPUT', 'TEXTAREA', 'svg', 'IMG', 'CANVAS'].includes(element.tagName))
  );
};

async function waitForVisibleContent(page) {
  await page.waitForFunction(VISIBLE_CONTENT, undefined, { timeout: 20_000 });
}

async function waitForImages(page) {
  await page.waitForFunction(
    async () => {
      const images = [...document.images].filter((img) => {
        const rect = img.getBoundingClientRect();
        const css = getComputedStyle(img);
        return !(
          css.display === 'none' ||
          css.visibility === 'hidden' ||
          rect.width === 0 ||
          rect.height === 0 ||
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= innerHeight ||
          rect.left >= innerWidth
        );
      });
      if (images.some((img) => !img.complete || img.naturalWidth === 0)) return false;
      const decoded = await Promise.all(
        images.map(async (img) => {
          const src = img.currentSrc || img.src;
          try {
            await img.decode();
            return img.isConnected && (img.currentSrc || img.src) === src;
          } catch {
            // The avatar cache can swap raw URLs for blobs while decoding.
            return false;
          }
        })
      );
      return decoded.every(Boolean);
    },
    undefined,
    { timeout: 20_000 }
  );
}

async function settleLayout(page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 15_000 }
  );
  // Require consecutive equal geometry samples, rather than sleeping past an
  // assumed render duration. Animated decorations are covered by screenshots.
  await page.waitForFunction(
    () => {
      // Menus and dialogs are portalled outside the story root. Their
      // positioners can resize after the trigger has already stopped moving.
      const boxes = [...document.body.querySelectorAll('*')]
        .filter((el) => !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        });
      const current = JSON.stringify(boxes);
      const state = window.__lodyVisualLayout ?? { current: '', stable: 0 };
      state.stable = state.current === current ? state.stable + 1 : 0;
      state.current = current;
      window.__lodyVisualLayout = state;
      return state.stable >= 3;
    },
    undefined,
    { timeout: 15_000, polling: 100 }
  );
}

async function applySteps(page, steps = []) {
  for (const step of steps) {
    if (step.action === 'movePointer') {
      await page.mouse.move(step.x ?? 0, step.y ?? 0);
      continue;
    }
    const target = step.role
      ? page.getByRole(step.role, { name: step.name, exact: step.exact ?? true })
      : step.text
        ? page.getByText(step.text, { exact: step.exact ?? true })
        : page.locator(step.selector);
    const locator = step.index === undefined ? target : target.nth(step.index);
    if (step.action === 'click') await locator.click();
    else if (step.action === 'tap') await locator.tap();
    else if (step.action === 'hover') await locator.hover();
    else if (step.action === 'focus') await locator.focus();
    else if (step.action === 'fill') await locator.fill(step.value);
    else if (step.action === 'press') await locator.press(step.key);
    else if (step.action === 'visible') await locator.waitFor({ state: 'visible' });
    else if (step.action === 'hidden') await locator.waitFor({ state: 'hidden' });
    else if (step.action === 'disabled') {
      if (!(await locator.isDisabled()))
        throw new Error(`Expected disabled: ${JSON.stringify(step)}`);
    } else if (step.action === 'enabled') {
      if (!(await locator.isEnabled()))
        throw new Error(`Expected enabled: ${JSON.stringify(step)}`);
    } else throw new Error(`Unknown visual step: ${step.action}`);
  }
  await settleLayout(page);
}

async function capture({ phase, baseUrl, targetsFile, only }) {
  const targets = await readTargets(targetsFile);
  const storyIndex = await (await fetch(new URL('/index.json', baseUrl))).json();
  const iframeHtml = await (await fetch(new URL('/iframe.html', baseUrl))).text();
  const buildFingerprint = createHash('sha256')
    .update(iframeHtml)
    .update(JSON.stringify(storyIndex))
    .digest('hex');
  const harnessFingerprint = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  const stories = selectStories(storyIndex, targets, only);
  if (!stories.length) {
    throw new Error('no story matched the configured targets');
  }

  const outDir = path.join(artifactsRoot, phase);
  const manifestPath = path.join(outDir, 'manifest.json');
  await mkdir(path.join(outDir, 'shots'), { recursive: true });

  // A completed manifest can resume failed frames. An interrupted capture
  // without a manifest must recapture its unrecorded frames.
  const resume = process.argv.includes('--resume');
  if (resume && iframeHtml.includes('/@vite/client')) {
    throw new Error(
      'Resume requires an immutable static build; dev modules can change independently of the iframe.'
    );
  }
  const done = new Map();
  if (resume && existsSync(manifestPath)) {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      previous.buildFingerprint !== buildFingerprint ||
      previous.harnessFingerprint !== harnessFingerprint ||
      JSON.stringify(previous.targets) !== JSON.stringify(targets)
    ) {
      throw new Error(
        'Resume requires the same captured build, harness and targets; use a new phase when any changes.'
      );
    }
    for (const entry of previous.entries ?? []) {
      if (existsSync(path.join(outDir, entry.shot))) done.set(entry.key, entry);
    }
    console.log(`[visual] resuming phase "${phase}" with ${done.size} frames already captured`);
  } else {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, 'shots'), { recursive: true });
  }

  const browser = await launchBrowser();
  const manifest = [...done.values()];
  const failures = [];
  const workers = Number(process.env.LODY_VISUAL_WORKERS ?? 6);

  for (const viewport of targets.viewports) {
    for (const theme of targets.themes) {
      const device = viewport.device ? devices[viewport.device] : undefined;
      if (viewport.device && !device) throw new Error(`Unknown browser device: ${viewport.device}`);
      const context = await browser.newContext({
        ...device,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: targets.reducedMotion ?? 'reduce',
      });
      // Playwright's clock belongs to the context; initialize it before pages run concurrently.
      const clockPage = await context.newPage();
      await clockPage.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await clockPage.close();
      for (let offset = 0; offset < stories.length; offset += workers) {
        const batch = stories.slice(offset, offset + workers);
        await Promise.all(
          batch.map(async (story) => {
            const key = `${story.id}__${viewport.name}__${theme}`;
            if (
              [
                key,
                ...(targets.states?.[story.id] ?? []).map((state) => `${key}__${state.name}`),
              ].every((stateKey) => done.has(stateKey))
            )
              return;
            // Native Back/Forward state must not depend on worker allocation.
            const page = await context.newPage();
            const shotPath = path.join(outDir, 'shots', `${key}.png`);
            let activeKey = key;
            try {
              if (targets.blockedHosts?.length) {
                // CDP blocking preserves HTTP caching, unlike request routing.
                const network = await context.newCDPSession(page);
                await network.send('Network.enable');
                await network.send('Network.setBlockedURLs', {
                  urls: targets.blockedHosts.map((host) => `*://${host}/*`),
                });
              }
              await page.mouse.move(-10, -10);
              await page.goto(storyUrl(baseUrl, story.id, theme, 'en'), {
                waitUntil: 'load',
                timeout: 60_000,
              });
              const allowBlank = targets.allowBlankIds?.includes(story.id) ?? false;
              await waitForStory(page, allowBlank);
              if (targets.ready?.[story.id]) await applySteps(page, targets.ready[story.id]);
              const states = [{ name: 'rest' }, ...(targets.states?.[story.id] ?? [])];
              for (const state of states) {
                const stateKey = state.name === 'rest' ? key : `${key}__${state.name}`;
                activeKey = stateKey;
                await applySteps(page, state.steps);
                if (done.has(stateKey)) continue;
                await waitForImages(page);
                if (!allowBlank) await waitForVisibleContent(page);
                const svgTime = viewport.svgTime ?? targets.svgTime;
                if (svgTime !== undefined) {
                  // Playwright's animation disabling does not fix SVG SMIL's timeline.
                  await page.evaluate((seconds) => {
                    for (const svg of document.querySelectorAll('svg')) {
                      svg.pauseAnimations();
                      svg.setCurrentTime(seconds);
                    }
                  }, svgTime);
                }
                const stateShotPath =
                  state.name === 'rest' ? shotPath : path.join(outDir, 'shots', `${stateKey}.png`);
                await page.screenshot({
                  path: stateShotPath,
                  animations: 'disabled',
                  caret: 'hide',
                });
                if (!allowBlank && !(await page.evaluate(VISIBLE_CONTENT)))
                  throw new Error('Visible content disappeared while capturing the screenshot');
                const layout = await page.evaluate(LAYOUT_SNAPSHOT);
                manifest.push({
                  key: stateKey,
                  state: state.name,
                  storyId: story.id,
                  title: story.title,
                  viewport: viewport.name,
                  theme,
                  shot: path.relative(outDir, stateShotPath),
                  layout,
                });
              }
            } catch (error) {
              const errorShot = path.join(outDir, 'shots', `${activeKey}__error.png`);
              await page.screenshot({ path: errorShot, caret: 'hide' }).catch(() => null);
              failures.push({
                key: activeKey,
                message: String(error?.message ?? error),
                shot: path.relative(outDir, errorShot),
              });
            } finally {
              await page.close();
            }
          })
        );
      }
      await context.close();
      console.log(
        `[visual] ${phase}: ${viewport.name}/${theme}: ${manifest.length} frames, ${failures.length} failures`
      );
    }
  }

  await browser.close();
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ phase, baseUrl, buildFingerprint, harnessFingerprint, targets, expected: stories.reduce((sum, story) => Number(sum) + 1 + Number(targets.states?.[story.id]?.length ?? 0), 0) * targets.viewports.length * targets.themes.length, capturedAt: new Date().toISOString(), entries: manifest }, null, 2)}\n`
  );
  await writeFile(path.join(outDir, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`);
  console.log(
    `[visual] captured ${manifest.length} frames for phase "${phase}" (${failures.length} failed)`
  );
  if (failures.length) process.exitCode = 1;
  return { manifest, failures };
}

/**
 * Compare two PNGs pixel by pixel inside a real browser canvas, and return the
 * difference image as a data URL.
 */
async function diffImages(page, beforeDataUrl, afterDataUrl) {
  return page.evaluate(
    async ([beforeSrc, afterSrc]) => {
      const load = (src) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('image decode failed'));
          image.src = src;
        });
      const [before, after] = await Promise.all([load(beforeSrc), load(afterSrc)]);
      const width = Math.max(before.width, after.width);
      const height = Math.max(before.height, after.height);
      const read = (image) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      };
      const a = read(before);
      const b = read(after);
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const outputContext = output.getContext('2d');
      const out = outputContext.createImageData(width, height);
      let changed = 0;
      // Threshold the summed RGB delta for the pixel gate; smaller changes
      // still remain observable through PNG equality and computed-style review.
      const threshold = 12;
      for (let index = 0; index < width * height; index += 1) {
        const offset = index * 4;
        const delta =
          Math.abs(a[offset] - b[offset]) +
          Math.abs(a[offset + 1] - b[offset + 1]) +
          Math.abs(a[offset + 2] - b[offset + 2]);
        if (delta > threshold) {
          changed += 1;
          out.data[offset] = 255;
          out.data[offset + 1] = 0;
          out.data[offset + 2] = 255;
          out.data[offset + 3] = 255;
        } else {
          const grey = 255 - (255 - b[offset]) * 0.18;
          out.data[offset] = grey;
          out.data[offset + 1] = grey;
          out.data[offset + 2] = grey;
          out.data[offset + 3] = 255;
        }
      }
      outputContext.putImageData(out, 0, 0);
      return {
        changed,
        total: width * height,
        ratio: width * height === 0 ? 0 : changed / (width * height),
        width,
        height,
        dataUrl: output.toDataURL('image/png'),
      };
    },
    [beforeDataUrl, afterDataUrl]
  );
}

async function readDataUrl(file) {
  const buffer = await readFile(file);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/** Compare two layout snapshots entry by entry. */
function diffLayout(before, after) {
  const beforeByPath = new Map(before.map((row) => [row.path, row]));
  const afterByPath = new Map(after.map((row) => [row.path, row]));
  const changes = [];
  for (const [rowPath, row] of beforeByPath) {
    const other = afterByPath.get(rowPath);
    if (!other) {
      changes.push({ path: rowPath, kind: 'removed', before: row });
      continue;
    }
    if (other.tag !== row.tag) {
      changes.push({ path: rowPath, kind: 'tag', before: row, after: other });
      continue;
    }
    const fields = [
      'rect',
      'fontSize',
      'fontFamily',
      'fontWeight',
      'lineHeight',
      'color',
      'backgroundColor',
      'borderRadius',
      'boxShadow',
      'opacity',
    ];
    const differing = fields.filter((field) => {
      const left = JSON.stringify(row[field]);
      const right = JSON.stringify(other[field]);
      return left !== right;
    });
    if (differing.length) {
      changes.push({
        path: rowPath,
        kind: 'changed',
        fields: differing,
        before: Object.fromEntries(differing.map((field) => [field, row[field]])),
        after: Object.fromEntries(differing.map((field) => [field, other[field]])),
        text: row.text,
      });
    }
  }
  for (const [rowPath, row] of afterByPath) {
    if (!beforeByPath.has(rowPath)) changes.push({ path: rowPath, kind: 'added', after: row });
  }
  return changes;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(' × ');
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Combine real captures while keeping the source of each frame auditable. */
async function assemble({ phases, phase }) {
  const destination = path.join(artifactsRoot, phase);
  await mkdir(path.join(destination, 'shots'), { recursive: true });
  const entries = new Map();
  const failures = new Map();
  const expectedKeys = new Set();
  const sources = [];
  for (const sourcePhase of phases) {
    if (sourcePhase === phase) throw new Error('assemble output must differ from its inputs');
    const sourceDir = path.join(artifactsRoot, sourcePhase);
    const manifest = JSON.parse(await readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
    const errors = JSON.parse(await readFile(path.join(sourceDir, 'failures.json'), 'utf8'));
    sources.push({
      phase: sourcePhase,
      baseUrl: manifest.baseUrl,
      capturedAt: manifest.capturedAt,
      buildFingerprint: manifest.buildFingerprint,
      harnessFingerprint: manifest.harnessFingerprint,
      sources: manifest.sources,
      failures: errors,
    });
    const storyIds = new Set([
      ...manifest.entries.map((entry) => entry.storyId),
      ...errors.map((entry) => entry.key.split('__')[0]),
    ]);
    for (const storyId of storyIds) {
      const states = [
        'rest',
        ...(manifest.targets?.states?.[storyId] ?? []).map((state) => state.name),
      ];
      for (const viewport of manifest.targets?.viewports ?? []) {
        for (const theme of manifest.targets?.themes ?? []) {
          for (const state of states)
            expectedKeys.add(
              `${storyId}__${viewport.name}__${theme}${state === 'rest' ? '' : `__${state}`}`
            );
        }
      }
    }
    for (const error of errors) failures.set(error.key, { ...error, sourcePhase });
    for (const entry of manifest.entries) {
      const shot = path.join('shots', `${entry.key}.png`);
      await copyFile(path.join(sourceDir, entry.shot), path.join(destination, shot));
      entries.set(entry.key, {
        ...entry,
        shot,
        sourcePhase: entry.sourcePhase ?? sourcePhase,
        baseUrl: entry.baseUrl ?? manifest.baseUrl,
      });
      expectedKeys.add(entry.key);
    }
  }
  // Successful recaptures supersede failures; source manifests retain the history.
  for (const key of entries.keys()) failures.delete(key);
  for (const key of expectedKeys) {
    if (!entries.has(key) && !failures.has(key))
      failures.set(key, { key, message: 'Expected state was not captured' });
  }
  const manifest = {
    phase,
    baseUrl: 'See each frame source phase',
    capturedAt: new Date().toISOString(),
    expected: expectedKeys.size,
    sources,
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  await writeFile(
    path.join(destination, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(destination, 'failures.json'),
    `${JSON.stringify([...failures.values()], null, 2)}\n`
  );
  console.log(
    `[visual] assembled ${manifest.entries.length}/${manifest.expected} frames (${failures.size} unresolved failures)`
  );
  if (failures.size) process.exitCode = 1;
}

async function buildReport({ beforePhase, afterPhase, reportName = 'report', contextFile }) {
  const beforeDir = path.join(artifactsRoot, beforePhase);
  const afterDir = path.join(artifactsRoot, afterPhase);
  const beforeManifest = JSON.parse(await readFile(path.join(beforeDir, 'manifest.json'), 'utf8'));
  const afterManifest = JSON.parse(await readFile(path.join(afterDir, 'manifest.json'), 'utf8'));
  const beforeFailures = JSON.parse(await readFile(path.join(beforeDir, 'failures.json'), 'utf8'));
  const afterFailures = JSON.parse(await readFile(path.join(afterDir, 'failures.json'), 'utf8'));
  const acceptance = contextFile ? JSON.parse(await readFile(contextFile, 'utf8')) : {};
  const afterByKey = new Map(afterManifest.entries.map((entry) => [entry.key, entry]));

  const browser = await launchBrowser();
  const page = await browser.newPage();
  const results = [];

  for (const entry of beforeManifest.entries) {
    const counterpart = afterByKey.get(entry.key);
    if (!counterpart) {
      results.push({ entry, status: 'missing-after' });
      continue;
    }
    const beforeUrl = await readDataUrl(path.join(beforeDir, entry.shot));
    const afterUrl = await readDataUrl(path.join(afterDir, counterpart.shot));
    const diff = await diffImages(page, beforeUrl, afterUrl);
    const layoutChanges = diffLayout(entry.layout, counterpart.layout);
    results.push({
      entry,
      counterpart,
      status: diff.ratio === 0 && layoutChanges.length === 0 ? 'identical' : 'changed',
      diff,
      layoutChanges,
      beforeUrl,
      afterUrl,
      pngIdentical: beforeUrl === afterUrl,
    });
  }
  const beforeKeys = new Set(beforeManifest.entries.map((entry) => entry.key));
  for (const counterpart of afterManifest.entries) {
    if (beforeKeys.has(counterpart.key)) continue;
    results.push({
      entry: counterpart,
      counterpart,
      status: 'missing-before',
      afterUrl: await readDataUrl(path.join(afterDir, counterpart.shot)),
    });
  }
  await browser.close();

  const changed = results.filter((result) => result.status === 'changed');
  const identical = results.filter((result) => result.status === 'identical');
  const missing = results.filter(
    (result) => result.status === 'missing-after' || result.status === 'missing-before'
  );

  const groups = new Map();
  for (const result of results) {
    const group = result.entry.title;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(result);
  }

  const html = renderReport({
    beforePhase,
    afterPhase,
    groups,
    beforeManifest,
    afterManifest,
    beforeFailures,
    afterFailures,
    acceptance,
    counts: {
      total: results.length,
      identical: identical.length,
      changed: changed.length,
      missing: missing.length,
      pngIdentical: results.filter((result) => result.pngIdentical).length,
      pixelEquivalent: results.filter((result) => result.diff?.ratio === 0).length,
    },
  });

  const reportPath = path.join(artifactsRoot, `${reportName}.html`);
  await writeFile(reportPath, html);
  await writeFile(
    path.join(artifactsRoot, `${reportName}.json`),
    `${JSON.stringify(
      results.map((result) => ({
        key: result.entry.key,
        title: result.entry.title,
        viewport: result.entry.viewport,
        theme: result.entry.theme,
        status: result.status,
        diffRatio: result.diff?.ratio ?? null,
        changedPixels: result.diff?.changed ?? null,
        layoutChanges: result.layoutChanges?.length ?? null,
        pngIdentical: result.pngIdentical ?? false,
      })),
      null,
      2
    )}\n`
  );
  console.log(
    `[visual] report written to ${reportPath} (${identical.length} identical, ${changed.length} changed, ${missing.length} missing)`
  );
  if (changed.length || missing.length || beforeFailures.length || afterFailures.length)
    process.exitCode = 1;
  return reportPath;
}

function renderReport({
  beforePhase,
  afterPhase,
  groups,
  counts,
  beforeManifest,
  afterManifest,
  beforeFailures,
  afterFailures,
  acceptance,
}) {
  const list = (values = []) => values.map((value) => `<li>${escapeHtml(value)}</li>`).join('');
  const coverage = (acceptance.coverage ?? [])
    .map(
      (item) =>
        `<tr><td><code>${escapeHtml(item.file)}</code></td><td>${escapeHtml(String(item.before))}</td><td>${escapeHtml(String(item.after))}</td><td>${escapeHtml(item.remaining)}</td></tr>`
    )
    .join('');
  const evidencePairs = (acceptance.evidencePairs ?? [])
    .map(
      (item) =>
        `<h4>${escapeHtml(item.label)}</h4><div class="shots"><figure><figcaption>Before</figcaption><img src="${item.beforeUrl}" alt="${escapeHtml(item.label)} before" loading="lazy"></figure><figure><figcaption>After</figcaption><img src="${item.afterUrl}" alt="${escapeHtml(item.label)} after" loading="lazy"></figure></div>`
    )
    .join('');
  const acceptanceHtml = `<section class="frame"><h2>Migration scope and checks</h2>
    <ul>${list(acceptance.scope)}</ul>${coverage ? `<table><thead><tr><th>Component</th><th>Utilities before</th><th>Utilities after</th><th>Remaining compatibility</th></tr></thead><tbody>${coverage}</tbody></table>` : ''}<h3>Validation</h3><ul>${list(acceptance.checks)}</ul>
    <h3>Known limits and next batches</h3><ul>${list(acceptance.limits)}</ul>
    ${evidencePairs ? `<h3>${escapeHtml(acceptance.evidenceTitle ?? 'Additional browser evidence')}</h3><p>${escapeHtml(acceptance.evidenceDescription ?? 'Supplemental screenshots are separate from the quantified component comparisons below.')}</p>${evidencePairs}` : ''}
    ${(acceptance.evidence ?? []).length ? `<h3>${escapeHtml(acceptance.evidenceHeading ?? 'Real Electron application smoke test — after only')}</h3><p>${escapeHtml(acceptance.evidenceDescriptionSingle ?? 'These application screenshots are separate from the paired component comparisons below.')}</p><div class="shots">` + acceptance.evidence.map((item) => `<figure><figcaption>${escapeHtml(item.label)}</figcaption><img src="${item.dataUrl}" alt="${escapeHtml(item.label)}" loading="lazy"></figure>`).join('') + '</div>' : ''}
    </section>`;
  const failureRows = [
    ['Before', beforeFailures],
    ['After', afterFailures],
  ]
    .flatMap(([phase, failures]) =>
      failures.map(
        (failure) =>
          `<tr><td>${phase}</td><td>${escapeHtml(failure.key)}</td><td><pre>${escapeHtml(failure.message)}</pre></td></tr>`
      )
    )
    .join('');
  const groupSections = [...groups.entries()]
    .map(([title, groupResults]) => {
      const changedCount = groupResults.filter(
        (result) => result.status !== 'identical' || !result.pngIdentical
      ).length;
      const rows = groupResults
        .map((result) => {
          const entry = result.entry;
          const badgeLabel =
            result.status === 'changed' && result.diff?.ratio === 0
              ? result.pngIdentical
                ? 'identical PNG · raw CSS differs'
                : 'below pixel threshold · raw CSS differs'
              : result.status === 'identical' && !result.pngIdentical
                ? 'below pixel threshold'
                : result.status;
          const head = `
            <div class="frame-head">
              <span class="frame-title">${escapeHtml(entry.title)}</span>
              <span class="meta">${escapeHtml(entry.storyId)}</span>
              <span class="badge ${result.status}">${escapeHtml(badgeLabel)}</span>
              <span class="meta">${escapeHtml(entry.viewport)} · ${escapeHtml(entry.theme)}</span>
              <span class="meta">${escapeHtml(entry.state ?? 'rest')}</span>
              <span class="meta">source: ${escapeHtml(entry.sourcePhase ?? beforePhase)} → ${escapeHtml(result.counterpart?.sourcePhase ?? afterPhase)}</span>
              ${
                result.diff
                  ? `<span class="meta">${(result.diff.ratio * 100).toFixed(4)}% px changed</span>`
                  : ''
              }
              ${result.layoutChanges?.length ? `<span class="meta">${result.layoutChanges.length} raw property changes</span>` : ''}
            </div>`;
          if (result.status === 'missing-after') {
            return `<section class="frame">${head}<p class="note">No capture in phase “${escapeHtml(afterPhase)}”.</p></section>`;
          }
          if (result.status === 'missing-before') {
            return `<section class="frame">${head}<p class="note">No successful before capture; this frame cannot establish visual equivalence.</p><figure><figcaption>After only</figcaption><img src="${result.afterUrl}" alt="after only" loading="lazy"></figure></section>`;
          }
          const diffImage = result.diff?.dataUrl
            ? `<figure><figcaption>Difference</figcaption><img src="${result.diff.dataUrl}" alt="difference" loading="lazy" /></figure>`
            : '';
          const layoutList = result.layoutChanges?.length
            ? `<div class="layout"><h4>Raw geometry and computed-style differences</h4><ul>${result.layoutChanges
                .slice(0, 40)
                .map(
                  (change) =>
                    `<li><code>${escapeHtml(change.path)}</code> ${escapeHtml(change.kind)} ${escapeHtml(
                      change.fields?.join(', ') ?? ''
                    )}<br /><span class="before">${escapeHtml(
                      change.before ? formatValue(change.before) : ''
                    )}</span> → <span class="after">${escapeHtml(
                      change.after ? formatValue(change.after) : ''
                    )}</span>${change.text ? ` <em>“${escapeHtml(change.text)}”</em>` : ''}</li>`
                )
                .join('')}</ul>${
                result.layoutChanges.length > 40
                  ? `<p class="note">…and ${result.layoutChanges.length - 40} more</p>`
                  : ''
              }</div>`
            : '';
          return `
            <section class="frame ${result.status} ${!result.pngIdentical ? 'raw-png-difference' : ''} ${result.diff?.ratio === 0 ? 'pixel-same' : ''}">
              ${head}
              <div class="shots">
                <figure><figcaption>Before — ${escapeHtml(beforePhase)}</figcaption><img src="${result.beforeUrl}" alt="before" loading="lazy" /></figure>
                <figure><figcaption>After — ${escapeHtml(afterPhase)}</figcaption><img src="${result.afterUrl}" alt="after" loading="lazy" /></figure>
                ${diffImage}
              </div>
              ${layoutList}
            </section>`;
        })
        .join('');
      return `<details class="group"><summary>${escapeHtml(title)} <span class="count">${changedCount}/${groupResults.length} raw differences</span></summary>${rows}</details>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tailwind → StyleX visual acceptance — ${escapeHtml(beforePhase)} vs ${escapeHtml(afterPhase)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9; color: #16181d; }
  header { padding: 28px 32px 20px; background: #16181d; color: #fff; }
  header h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.01em; }
  header p { margin: 0; opacity: 0.75; max-width: 70ch; }
  .summary { display: flex; gap: 12px; flex-wrap: wrap; padding: 18px 32px; background: #fff; border-bottom: 1px solid #e3e5ea; }
  .summary div { border: 1px solid #e3e5ea; border-radius: 10px; padding: 8px 14px; background: #fbfcfd; }
  .summary strong { display: block; font-size: 20px; }
  main { padding: 24px 32px 64px; }
  .group { margin-bottom: 32px; }
  .group h3 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6270; }
  .count { text-transform: none; letter-spacing: 0; color: #8b93a1; font-weight: 400; }
  .frame { background: #fff; border: 1px solid #e3e5ea; border-radius: 12px; padding: 14px; margin-bottom: 14px; min-width:0; overflow-wrap:anywhere; }
  .frame.changed { border-color: #f0b3b3; }
  .frame.changed.pixel-same { border-color:#ead9a2; }
  .pixel-same .badge.changed { background:#fff7df; border-color:#ead9a2; color:#805d00; }
  .frame-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
  .frame-title { font-weight: 600; }
  .meta { color: #6b7280; font-size: 12px; }
  .badge { border-radius: 999px; padding: 1px 9px; font-size: 11px; border: 1px solid #d5d9e0; background: #f2f4f7; }
  .badge.changed { background: #fdecec; border-color: #f0b3b3; color: #a52222; }
  .badge.identical { background: #eaf7ee; border-color: #b6dfc4; color: #1f7a3d; }
  .badge.missing-after { background: #fff6e5; border-color: #f0d9a8; color: #8a6100; }
  .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 12px; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  figure img { width: 100%; border: 1px solid #e3e5ea; border-radius: 8px; background: #fff; display: block; cursor:zoom-in; }
  #image-viewer { max-width:96vw; max-height:96vh; padding:16px; border:1px solid #ccc; border-radius:10px; }
  #image-viewer::backdrop { background:rgba(0,0,0,.75); }
  #image-viewer img { display:block; max-width:none; margin-top:12px; }
  #image-viewer button { position:sticky; top:0; }
  .layout { margin-top: 12px; }
  .layout h4 { margin: 0 0 6px; font-size: 13px; }
  .layout ul { margin: 0; padding-left: 18px; }
  .layout li { margin-bottom: 4px; }
  .before { color: #a52222; } .after { color: #1f7a3d; }
  code { background: #f2f4f7; padding: 0 4px; border-radius: 4px; }
  .note { color: #6b7280; }
  summary { cursor:pointer; padding:12px 0; font-weight:600; }
  .controls { position:sticky; top:0; z-index:2; padding:12px 32px; background:#fff; border-bottom:1px solid #ddd; display:flex; flex-wrap:wrap; gap:16px; align-items:center; }
  .controls input[type=search] { padding:6px 10px; min-width:min(260px, 100%); max-width:100%; }
  [hidden] { display:none !important; }
  table { display:block; max-width:100%; overflow-x:auto; width:100%; border-collapse:collapse; background:white; } td,th { text-align:left; padding:8px; border:1px solid #ddd; } pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  @media (max-width:600px) { header, .summary, .controls { padding-left:16px; padding-right:16px; } main { padding:16px 12px 40px; } }
</style>
</head>
<body>
<header>
  <h1>Tailwind → StyleX — visual acceptance</h1>
  <p>Paired frames were rendered in Chromium from this repository's production-component stories. The “Difference” image marks above-threshold pixels in magenta over a faded copy of the after frame; raw property changes retain geometry and computed-style differences. Click any screenshot to inspect its original size.</p>
</header>
${acceptance.verdict ? `<section class="frame" data-acceptance-verdict style="margin:16px 32px;border:2px solid #a75a00;background:#fff6e5"><h2>Partial visual acceptance — unresolved evidence remains</h2><p>${escapeHtml(acceptance.verdict)}</p></section>` : ''}
<p style="margin:16px 32px" data-summary-scope>Primary comparison metrics only. Supplemental native, controls and application evidence have separate outcomes below.</p>
<div class="summary">
  <div><strong>${counts.total}</strong>frames compared</div>
  <div><strong>${counts.identical}</strong>pixel threshold + raw styles match</div>
  <div><strong>${counts.changed}</strong>threshold-pixel/computed-style differences</div>
  <div><strong>${counts.total - counts.pngIdentical}</strong>PNG files differ (including below threshold)</div>
  <div><strong>${counts.missing}</strong>missing comparison frames</div>
  <div><strong>${beforeFailures.length + afterFailures.length}</strong>capture failures (never passed)</div>
  <div><strong>${counts.pngIdentical}</strong>PNG files byte-identical</div>
  <div><strong>${counts.pixelEquivalent}</strong>no pixels above RGB threshold</div>
</div>
<div class="controls"><input type="search" id="search" aria-label="Search cases" placeholder="Search story, theme, viewport…"><label><input type="checkbox" id="changed-only"> Raw differences only</label><button id="expand-all">Expand visible groups</button></div>
<main>
${acceptanceHtml}
<section class="frame"><h2>Capture provenance and scope</h2>
<p>Before: ${escapeHtml(beforeManifest.baseUrl)} · ${escapeHtml(beforeManifest.capturedAt)} · ${beforeManifest.entries.length}/${beforeManifest.expected ?? 'unknown'} expected frames.<br>After: ${escapeHtml(afterManifest.baseUrl)} · ${escapeHtml(afterManifest.capturedAt)} · ${afterManifest.entries.length}/${afterManifest.expected ?? 'unknown'} expected frames.</p>
<p>These phases compare the working tree at the start of this continuation with its final state. Earlier unfinished migration work is already present in the baseline. Stories mount production components with synthetic local data; screenshots are Chromium output. This report does not establish end-to-end desktop/backend equivalence for unvisited routes.</p>
<p>Layout snapshots include portals. Pixel differences use a summed RGB delta greater than 12; layout and font changes remain visible even below that pixel threshold. Every changed frame requires review.</p>
${failureRows ? `<h3>Rendering failures — unresolved</h3><table><thead><tr><th>Phase</th><th>Case</th><th>Failure</th></tr></thead><tbody>${failureRows}</tbody></table>` : '<p>No rendering failures in either phase.</p>'}
</section>
${groupSections}
</main>
<dialog id="image-viewer" aria-label="Original-size screenshot"><button type="button">Close screenshot</button><img alt=""></dialog>
<script>
const viewer = document.getElementById('image-viewer');
const fullImage = viewer.querySelector('img');
function showImage(image) {
  fullImage.src = image.src;
  fullImage.alt = image.closest('figure').querySelector('figcaption')?.textContent || image.alt;
  viewer.showModal();
}
for (const image of document.querySelectorAll('figure img')) {
  image.tabIndex = 0;
  image.setAttribute('role', 'button');
  image.setAttribute('aria-label', 'Inspect screenshot: ' + image.alt);
  image.addEventListener('click', () => showImage(image));
  image.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showImage(image); }
  });
}
viewer.querySelector('button').addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => fullImage.removeAttribute('src'));
const search = document.getElementById('search');
const changed = document.getElementById('changed-only');
function filter() {
  const query = search.value.toLowerCase();
  for (const group of document.querySelectorAll('details.group')) {
    let visible = false;
    for (const frame of group.querySelectorAll('.frame')) {
      frame.hidden = (changed.checked && frame.classList.contains('identical') && !frame.classList.contains('raw-png-difference')) || !frame.textContent.toLowerCase().includes(query);
      visible ||= !frame.hidden;
    }
    group.hidden = !visible;
    if (query || changed.checked) group.open = visible;
  }
}
search.addEventListener('input', filter);
changed.addEventListener('change', filter);
document.getElementById('expand-all').addEventListener('click', () => {
  for (const group of document.querySelectorAll('details.group:not([hidden])')) group.open = true;
});
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = process.argv[2];
  const baseUrl = args.storybook ?? DEFAULT_STORYBOOK;
  const targetsFile = args.targets
    ? path.resolve(process.cwd(), args.targets)
    : path.join(here, 'targets.json');

  if (command === 'capture') {
    if (!args.phase) throw new Error('--phase <name> is required');
    await capture({
      phase: args.phase,
      baseUrl,
      targetsFile,
      only: typeof args.only === 'string' ? args.only : undefined,
    });
    return;
  }
  if (command === 'report') {
    await buildReport({
      beforePhase: args.before ?? 'before',
      afterPhase: args.after ?? 'after',
      reportName: args.name ?? 'report',
      contextFile: args.context,
    });
    return;
  }
  if (command === 'assemble') {
    if (!args.phases || !args.phase) throw new Error('assemble needs --phases a,b --phase output');
    await assemble({ phases: args.phases.split(','), phase: args.phase });
    return;
  }
  throw new Error(
    'usage: visual-regression.mjs capture --phase <name> | report --before <phase> --after <phase>'
  );
}

await main();
