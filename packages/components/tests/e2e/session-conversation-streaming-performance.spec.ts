import { expect, test, type Page } from '@playwright/test';

const STORY_URL =
  '/iframe.html?id=sessions-sessionconversationpage--desktop-streaming-working&viewMode=story';

type TraceEvent = {
  name?: string;
  cat?: string;
  ph?: string;
  dur?: number;
};

type EventMetric = {
  count: number;
  totalMs: number;
  maxMs: number;
  eventNames: Record<string, number>;
};

const TRACE_CATEGORIES = [
  'blink',
  'cc',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
].join(',');

const METRIC_PATTERNS = {
  Layerize: /layerize/i,
  Paint: /^(PrePaint|Paint|PaintImage)$/,
  Commit: /commit/i,
  Layout: /^(Layout|UpdateLayoutTree)$/,
} as const;

async function captureTrace(page: Page, durationMs: number): Promise<TraceEvent[]> {
  const client = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  client.on('Tracing.dataCollected', ({ value }: { value: TraceEvent[] }) => {
    events.push(...value);
  });
  const complete = new Promise<void>((resolve) => {
    client.once('Tracing.tracingComplete', () => resolve());
  });

  await client.send('Tracing.start', {
    categories: TRACE_CATEGORIES,
    options: 'record-as-much-as-possible',
  });
  await page.waitForTimeout(durationMs);
  await client.send('Tracing.end');
  await complete;
  await client.detach();
  return events;
}

function summarizeTrace(events: TraceEvent[]): Record<keyof typeof METRIC_PATTERNS, EventMetric> {
  return Object.fromEntries(
    Object.entries(METRIC_PATTERNS).map(([metric, pattern]) => {
      const matchingEvents = events.filter(
        (event): event is TraceEvent & { name: string } =>
          event.ph === 'X' && Boolean(event.name && pattern.test(event.name))
      );
      const durationsMs = matchingEvents.map((event) => (event.dur ?? 0) / 1000);
      const eventNames = matchingEvents.reduce<Record<string, number>>((counts, event) => {
        counts[event.name] = (counts[event.name] ?? 0) + 1;
        return counts;
      }, {});
      return [
        metric,
        {
          count: durationsMs.length,
          totalMs: Number(durationsMs.reduce((total, duration) => total + duration, 0).toFixed(2)),
          maxMs: Number(Math.max(0, ...durationsMs).toFixed(2)),
          eventNames,
        },
      ];
    })
  ) as Record<keyof typeof METRIC_PATTERNS, EventMetric>;
}

test('captures render work while streaming and while only the working indicator remains', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    browserErrors.push(
      `pageerror: ${error.name}: ${error.message}\n${error.stack ?? '(no stack available)'}`
    );
  });
  page.on('requestfailed', (request) => {
    browserErrors.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`
    );
  });
  page.on('response', (browserResponse) => {
    if (browserResponse.status() >= 400) {
      browserErrors.push(`response: ${browserResponse.status()} ${browserResponse.url()}`);
    }
  });
  const response = await page.goto(STORY_URL);
  expect(response?.ok()).toBeTruthy();

  const story = page.getByTestId('session-conversation-story');
  try {
    await expect(story).toHaveAttribute('data-stream-phase', 'streaming', { timeout: 15_000 });
  } catch (error) {
    const browserState = await page.evaluate(() => ({
      readyState: document.readyState,
      bodyText: document.body.innerText.slice(0, 2_000),
      scripts: Array.from(document.scripts, (script) => script.src || '(inline)'),
    }));
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `browser errors:\n${browserErrors.join('\n') || '(none)'}`,
        `browser state:\n${JSON.stringify(browserState, null, 2)}`,
      ].join('\n\n'),
      { cause: error }
    );
  }
  await expect(page.getByText('Thinking', { exact: true })).toBeVisible();
  const cssAnimationNames = await story.evaluate((element) => {
    const dot = element.querySelector('.agent-activity-dot-pulse');
    const label = element.querySelector('.agent-activity-label');
    return {
      dot: dot ? window.getComputedStyle(dot).animationName : null,
      label: label ? window.getComputedStyle(label, '::after').animationName : null,
    };
  });
  expect(cssAnimationNames).toEqual({
    dot: 'agent-activity-dot-pulse',
    label: 'agent-activity-label-highlight',
  });

  const streamingEvents = await captureTrace(page, 4_000);
  const streaming = summarizeTrace(streamingEvents);

  await expect(story).toHaveAttribute('data-stream-phase', 'indicator-only', { timeout: 20_000 });
  const indicatorOnlyEvents = await captureTrace(page, 4_000);
  const indicatorOnly = summarizeTrace(indicatorOnlyEvents);

  const summary = {
    traceWindowMs: 4_000,
    streaming,
    indicatorOnly,
  };
  await testInfo.attach('session-conversation-render-trace-summary.json', {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  });
  console.info(JSON.stringify(summary, null, 2));

  expect(streaming.Paint.count).toBeGreaterThan(0);
  expect(streaming.Layout.count).toBeGreaterThan(0);
  expect(indicatorOnly.Layerize.totalMs).toBeLessThan(streaming.Layerize.totalMs);
  expect(indicatorOnly.Paint.totalMs).toBeLessThan(streaming.Paint.totalMs);
  expect(indicatorOnly.Commit.totalMs).toBeLessThan(streaming.Commit.totalMs);
  expect(indicatorOnly.Layout.totalMs).toBeLessThan(streaming.Layout.totalMs);
  expect(indicatorOnly.Layerize.totalMs).toBeLessThan(10);
  expect(indicatorOnly.Paint.totalMs).toBeLessThan(20);
  expect(indicatorOnly.Commit.totalMs).toBeLessThan(30);
  expect(indicatorOnly.Layout.totalMs).toBeLessThan(20);
});
