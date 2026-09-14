/**
 * Frame-accurate capture of the conversation-open flash reported after #376.
 *
 * Drives the doc-backed Storybook stories under `Sessions/ConversationView`,
 * where the `LoroDoc`, the `ConversationView` and every `HistoryWriter.append`
 * happen while the stream is unmounted. Opening (or switching) therefore costs
 * exactly what the sidebar costs on an already-loaded session: one mount of
 * `SessionChatStreamView` over a warm view.
 *
 * Every animation frame records what the conversation pane actually shows —
 * whether the scroll viewport exists, its computed visibility, how many rows
 * Virtua has committed, and where the scroll sits. The blank window is the
 * span where the pane is mounted but nothing is readable.
 *
 *   Storybook (production numbers; the dev build inflates React render time):
 *     pnpm --filter @lody/components build-storybook -o /tmp/sb-static
 *     (cd /tmp/sb-static && python3 -m http.server 6007)
 *
 *   SB_URL=http://localhost:6007 node scripts/capture-conversation-open-flicker.mjs \
 *     --mode=switch --out=/tmp/flicker --repeats=4
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);
const MODE = args.mode ?? 'open';
const STORY =
  args.story ??
  (MODE === 'switch'
    ? 'sessions-conversationview--switch-between-long-conversations'
    : 'sessions-conversationview--open-long-conversation');
const OUT = args.out ?? `/tmp/conversation-open-flicker/${MODE}`;
const REPEATS = Number(args.repeats ?? 3);
const SETTLE_MS = Number(args.settle ?? 1500);
const SB_URL = process.env.SB_URL ?? 'http://localhost:6006';
/**
 * CPU throttling stretches the flash past the 40 ms period of the recorded
 * video, so the screen recording shows what the per-frame probe measures. It
 * also stands in for a slower machine than this one.
 */
const CPU_THROTTLE = Number(args.cpuThrottle ?? 1);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  recordVideo: { dir: `${OUT}/video`, size: { width: 1280, height: 820 } },
});
const page = await context.newPage();
const client = await context.newCDPSession(page);
await page.goto(`${SB_URL}/iframe.html?viewMode=story&id=${STORY}`, { waitUntil: 'load' });
// Building 3,000 turns through the writer is story setup, not the measurement.
await page.waitForSelector('text=view-ready', { timeout: 240_000 });
await page.waitForTimeout(1500);
if (CPU_THROTTLE > 1) {
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
}

const startProbe = () =>
  page.evaluate(() => {
    const samples = [];
    window.__flicker = { samples, t0: performance.now() };
    const probe = () => {
      const viewport = document.querySelector('[data-message-selection-scroll]');
      const content = viewport?.firstElementChild ?? null;
      const slot = document.querySelector('[data-testid="conversation-slot"]');
      const visibility = viewport ? getComputedStyle(viewport).visibility : null;
      samples.push({
        t: performance.now(),
        mounted: !!viewport,
        visibility,
        rows: content ? content.children.length : 0,
        scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
        scrollHeight: viewport ? Math.round(viewport.scrollHeight) : null,
        // What a reader can actually read at this frame.
        readableChars:
          slot && visibility === 'visible' ? slot.innerText.replace(/\s+/g, ' ').trim().length : 0,
      });
      window.__flicker.raf = requestAnimationFrame(probe);
    };
    probe();
  });

const stopProbe = () =>
  page.evaluate(() => {
    cancelAnimationFrame(window.__flicker.raf);
    const { samples, t0 } = window.__flicker;
    return samples.map((sample) => ({ ...sample, t: +(sample.t - t0).toFixed(1) }));
  });

const runs = [];
for (let round = 1; round <= REPEATS; round += 1) {
  await startProbe();
  if (MODE === 'switch') {
    await page.click(`[data-testid="select-conversation-${round % 2}"]`);
  } else {
    await page.click('[data-testid="open-conversation"]');
  }
  await page.waitForTimeout(SETTLE_MS);
  runs.push({ round, samples: await stopProbe() });
  if (MODE !== 'switch' && round < REPEATS) {
    await page.click('[data-testid="close-conversation"]');
    await page.waitForTimeout(500);
  }
}

writeFileSync(`${OUT}/samples.json`, JSON.stringify({ story: STORY, mode: MODE, runs }, null, 2));

/**
 * The blank window: from the frame where the outgoing content disappears to
 * the frame where the incoming conversation is readable again. Measured to
 * the readable frame rather than to the last blank sample, because the main
 * thread drops frames in between — the pane stays blank across that gap.
 */
const blankSpan = (samples) => {
  const from = samples.find(
    (sample) => !sample.mounted || sample.visibility !== 'visible' || sample.rows === 0
  );
  if (!from) return null;
  const to = samples.find((sample) => sample.t > from.t && sample.readableChars > 0);
  return { from: from.t, to: to?.t ?? null };
};

console.log(`\n=== ${STORY} (${MODE}, ${SB_URL}, CPU x${CPU_THROTTLE}) ===`);
console.log('round  goes blank at   readable again at   BLANK PANE FOR');
for (const { round, samples } of runs) {
  const blank = blankSpan(samples);
  console.log(
    `${String(round).padStart(5)}  ${String(blank ? `${blank.from.toFixed(0)} ms` : 'never').padStart(13)}  ${String(
      blank?.to != null ? `${blank.to.toFixed(0)} ms` : 'never'
    ).padStart(17)}  ${String(
      blank?.to != null ? `${(blank.to - blank.from).toFixed(0)} ms` : '—'
    ).padStart(14)}`
  );
  let previous = null;
  for (const s of samples) {
    const key = `${s.mounted}|${s.visibility}|${s.rows}|${s.scrollTop}`;
    if (key === previous) continue;
    previous = key;
    console.log(
      `       t=${String(s.t).padStart(7)}  vis=${String(s.visibility).padEnd(7)} rows=${String(
        s.rows
      ).padStart(
        3
      )} scrollTop=${String(s.scrollTop).padStart(7)}/${String(s.scrollHeight).padStart(7)}`
    );
  }
}

const video = page.video();
await context.close();
if (video) console.log(`\nvideo -> ${await video.path()}`);
console.log(`samples -> ${OUT}/samples.json`);
await browser.close();
