import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
} from '../../../src/lib/chat-workspace-geometry';
import {
  createGeometryFindings,
  observeGeometryCaptures,
  type GeometryCapture,
  type GeometryCaptureArtifact,
  type GeometryFindingArtifact,
  type GeometryObservationArtifact,
  type GeometryObservationCache,
  type GeometrySurfaceFamily,
} from '../../../src/lib/geometry-constraint-system';
import {
  auditChatWorkspaceSemanticAlignments,
  auditChatWorkspaceSemanticBaselines,
  discoverChatWorkspaceAlignmentRails,
  measureSettledChatWorkspace,
  type BrowserAlignmentRailDiscoveryScope,
  type BrowserSemanticAlignmentEntry,
  type BrowserSemanticBaselineEntry,
} from './chat-workspace-geometry';

export const geometryStorybookOrigin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:6006';

export type GeometryCaptureDimensions = Readonly<{
  theme: string;
  locale: string;
  density: string;
}>;

/** Storybook's own globals; there is no density global, so it stays constant. */
export const DEFAULT_CAPTURE_DIMENSIONS: GeometryCaptureDimensions = {
  theme: 'light',
  locale: 'en',
  density: 'default',
};

/**
 * One capture the pipeline reads. The report shoots it and the gate only
 * measures it: both walk THIS list, so a story the report reviews and a story
 * the ratchet enforces can never drift apart.
 */
export type GeometryCapturePlanEntry = Readonly<{
  captureId: string;
  /** Short, capture-id-free prefix the report names its detail ids after. */
  detailId: string;
  /** Report grouping; also the finding `surfaceFamily`. */
  area: GeometrySurfaceFamily & ('workspace' | 'session' | 'right-sidebar');
  surface: string;
  storyId: string;
  storyGlobals?: string;
  viewport: Readonly<{ width: number; height: number }>;
  deviceScaleFactor: number;
  dimensions: GeometryCaptureDimensions;
  aggregateScopes: readonly string[];
  /** Rendered text proving a globals-driven dimension actually applied. */
  expectedText?: string;
  /** Extra readiness selectors this story needs before it is measured. */
  readySelectors?: readonly string[];
  /**
   * Marker-rule observations ride ONE representative capture: they exist to ask
   * whether discovery has replaced a marker, not to be measured everywhere.
   */
  semanticObservations?: boolean;
}>;

const WIDE_VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * Dimensions vary ONE capture family rather than every story: they exist to show
 * whether a finding survives a theme or a locale, and a full matrix would
 * multiply the runtime for evidence nobody reads.
 */
export const GEOMETRY_WORKSPACE_DIMENSION_CAPTURES: readonly GeometryCapturePlanEntry[] = [
  {
    captureId: 'workspace:wide-expanded-dark',
    detailId: 'wide-expanded-dark',
    area: 'workspace',
    surface: 'Workspace / Chat Landing / Dark',
    storyId: 'geometry-chatworkspace--expanded-sidebar',
    storyGlobals: 'theme:dark',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: { ...DEFAULT_CAPTURE_DIMENSIONS, theme: 'dark' },
    aggregateScopes: ['sidebar.shell'],
  },
  {
    captureId: 'workspace:wide-expanded-zh',
    detailId: 'wide-expanded-zh',
    area: 'workspace',
    surface: 'Workspace / Chat Landing / 中文',
    storyId: 'geometry-chatworkspace--expanded-sidebar',
    storyGlobals: 'locale:zh_CN',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: { ...DEFAULT_CAPTURE_DIMENSIONS, locale: 'zh_CN' },
    aggregateScopes: ['sidebar.shell'],
    // A zh_CN capture that still rendered English strings would silently claim a
    // locale axis it never varied, so the capture asserts a translated label.
    // The Sidebar's Chats section header is the one this fixture translates.
    expectedText: '对话',
  },
];

export const GEOMETRY_WORKSPACE_STATE_CAPTURES: readonly GeometryCapturePlanEntry[] = (
  [
    ['landing-submitting', 'Submitting', 'geometry-chatworkspace--submission-pending'],
    [
      'landing-no-machine-download',
      'No Machine Download',
      'geometry-chatworkspace--no-machine-download',
    ],
    [
      'landing-no-machine-starting',
      'No Machine Starting',
      'geometry-chatworkspace--no-machine-starting',
    ],
    ['landing-no-agent', 'No Agent', 'geometry-chatworkspace--no-agent-config'],
    ['landing-long-model', 'Long Model', 'geometry-chatworkspace--long-model'],
    ['landing-pasted-text', 'Pasted Text', 'geometry-chatworkspace--pasted-text'],
  ] as const
).map(([id, name, storyId]) => ({
  captureId: `workspace:${id}:1440x900`,
  detailId: id,
  area: 'workspace' as const,
  surface: `Workspace / Chat Landing / ${name}`,
  storyId,
  viewport: WIDE_VIEWPORT,
  deviceScaleFactor: 2,
  dimensions: DEFAULT_CAPTURE_DIMENSIONS,
  aggregateScopes: ['sidebar.shell'],
}));

export const GEOMETRY_SESSION_STATE_CAPTURES: readonly GeometryCapturePlanEntry[] = [
  {
    captureId: 'session-idle:1440x900',
    detailId: 'session-idle',
    area: 'session',
    surface: 'Chat Session / Idle',
    storyId: 'sessions-sessionconversationpage--desktop-idle',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    aggregateScopes: ['session.page'],
  },
  {
    captureId: 'session-working:1440x900',
    detailId: 'session-working',
    area: 'session',
    surface: 'Chat Session / Working',
    storyId: 'sessions-sessionconversationpage--desktop-working-settled',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    aggregateScopes: ['session.page'],
    readySelectors: ['[data-stream-phase="indicator-only"]'],
  },
  {
    captureId: 'session-permission:1440x900',
    detailId: 'session-permission',
    area: 'session',
    surface: 'Chat Session / Permission',
    storyId: 'sessions-sessionconversationpage--desktop-permission-approval',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    aggregateScopes: ['session.page'],
    readySelectors: ['[data-geometry-capture-reveal="true"]:has(.lucide-info)'],
  },
  {
    captureId: 'session-question:1440x900',
    detailId: 'session-question',
    area: 'session',
    surface: 'Chat Session / Agent Question',
    storyId: 'sessions-sessionconversationpage--desktop-agent-question',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    aggregateScopes: ['session.page'],
  },
  /**
   * The one capture that holds all THREE region headers at once — the workspace
   * Sidebar's, the Session tab bar's and the right panel's. Every other capture
   * renders exactly one of them, and a geometric row is per CAPTURE, so without
   * this the question "do these three headers share a line?" cannot be measured
   * at all, whatever discovery does downstream.
   */
  {
    captureId: 'workspace-session:1440x900',
    detailId: 'workspace-session',
    area: 'session',
    surface: 'Workspace / Session + Side Panel',
    storyId: 'geometry-chatworkspace--workspace-session-side-panel',
    viewport: WIDE_VIEWPORT,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    aggregateScopes: ['sidebar.shell', 'session.side-panel'],
  },
];

export const GEOMETRY_RIGHT_SIDEBAR_STATE_CAPTURES: readonly GeometryCapturePlanEntry[] = (
  [
    [
      'session-right-sidebar-changes',
      'Changes',
      'sessions-sessionsidepaneltabbar--geometry-report',
    ],
    ['session-right-sidebar-tabs', 'Tabs', 'sessions-sessionsidepaneltabbar--unified-tabs'],
    ['session-right-sidebar-empty', 'Empty', 'sessions-sessionsidepaneltabbar--empty-state'],
  ] as const
).map(([id, name, storyId]) => ({
  captureId: `${id}:1440x900`,
  detailId: id,
  area: 'right-sidebar' as const,
  surface: `Chat Session / Right Sidebar / ${name}`,
  storyId,
  viewport: WIDE_VIEWPORT,
  deviceScaleFactor: 2,
  dimensions: DEFAULT_CAPTURE_DIMENSIONS,
  aggregateScopes: ['session.side-panel'],
}));

/** The viewport matrix, minus the representative capture that opens the plan. */
export const GEOMETRY_WORKSPACE_MATRIX_CAPTURES: readonly GeometryCapturePlanEntry[] =
  CHAT_WORKSPACE_GEOMETRY_SPEC.verificationCases
    .filter((verificationCase) => verificationCase.name !== 'wide-expanded')
    .map((verificationCase) => ({
      captureId: `workspace:${verificationCase.name}`,
      detailId: `workspace-${verificationCase.name}`,
      area: 'workspace' as const,
      surface: `Workspace / ${verificationCase.name}`,
      storyId:
        verificationCase.sidebar === 'expanded'
          ? 'geometry-chatworkspace--expanded-sidebar'
          : 'geometry-chatworkspace--collapsed-sidebar',
      viewport: verificationCase.viewport,
      deviceScaleFactor: 1,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
      aggregateScopes: ['sidebar.shell'],
    }));

export const GEOMETRY_REPRESENTATIVE_CAPTURE_ID = 'workspace:wide-expanded';

export const GEOMETRY_REPRESENTATIVE_CAPTURE: GeometryCapturePlanEntry = {
  captureId: GEOMETRY_REPRESENTATIVE_CAPTURE_ID,
  detailId: 'workspace',
  area: 'workspace',
  surface: 'Workspace / Chat Landing',
  storyId: 'geometry-chatworkspace--expanded-sidebar',
  viewport: WIDE_VIEWPORT,
  deviceScaleFactor: 2,
  dimensions: DEFAULT_CAPTURE_DIMENSIONS,
  aggregateScopes: ['sidebar.shell'],
  semanticObservations: true,
};

export const GEOMETRY_CAPTURE_PLAN: readonly GeometryCapturePlanEntry[] = [
  GEOMETRY_REPRESENTATIVE_CAPTURE,
  ...GEOMETRY_WORKSPACE_MATRIX_CAPTURES,
  ...GEOMETRY_WORKSPACE_DIMENSION_CAPTURES,
  ...GEOMETRY_WORKSPACE_STATE_CAPTURES,
  ...GEOMETRY_SESSION_STATE_CAPTURES,
  ...GEOMETRY_RIGHT_SIDEBAR_STATE_CAPTURES,
];

export async function waitForSessionConversationStory(page: Page): Promise<void> {
  await page.locator('[data-testid="session-conversation-story"]').waitFor({
    state: 'visible',
    timeout: 90_000,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

export async function enableGeometryCaptureMode(page: Page): Promise<void> {
  // Generous on purpose: the FIRST story in a cold browser context compiles and
  // parses the whole Storybook bundle, which is a minute on a loaded machine
  // and 4 seconds once warm. This is an explicit readiness signal, never a
  // sleep — the deadline only decides how loaded a machine may be.
  await page
    .locator('[data-geometry-fixture-ready="true"], [data-testid="session-conversation-story"]')
    .first()
    .waitFor({ state: 'attached', timeout: 180_000 });
  await page.addStyleTag({
    content: `
      [data-geometry-report-capture="true"] * {
        pointer-events: none !important;
        animation: none !important;
        transition: none !important;
      }
      [data-geometry-actions-visible="true"] [data-geometry-hover-action] {
        opacity: 1 !important;
        pointer-events: none !important;
      }
      [data-geometry-actions-visible="true"] [data-geometry-hover-rest] {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      [data-geometry-report-capture="true"] [data-geometry-capture-reveal="true"] {
        opacity: 1 !important;
        pointer-events: none !important;
      }
    `,
  });
  const workspace = page.locator(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  await page.locator('body').evaluate((element) => {
    element.setAttribute('data-geometry-report-capture', 'true');
    element.setAttribute('data-geometry-actions-visible', 'true');

    const interactiveSelector =
      'button, [role="button"], a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    for (const candidate of element.querySelectorAll<HTMLElement>('*')) {
      if (candidate.closest('[data-geometry-hover-rest]')) continue;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      const occupiesViewport =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right >= 0 &&
        rect.bottom >= 0 &&
        rect.left <= innerWidth &&
        rect.top <= innerHeight;
      const ownsInteraction =
        candidate.matches(interactiveSelector) || candidate.querySelector(interactiveSelector);
      if (
        Number.parseFloat(style.opacity) <= 0.01 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        occupiesViewport &&
        ownsInteraction
      ) {
        candidate.setAttribute('data-geometry-capture-reveal', 'true');
      }
    }
  });
  if ((await workspace.count()) > 0) {
    await workspace.evaluate((element) => {
      element.setAttribute('data-geometry-report-capture', 'true');
      element.setAttribute('data-geometry-actions-visible', 'true');
    });
  }

  const revealedSurfaces = page.locator('[data-geometry-capture-reveal="true"]');
  await revealedSurfaces.count();
}

export type GeometryReplayCapture = Readonly<{
  storyId: string;
  storyGlobals?: string;
  viewport: Readonly<{ width: number; height: number }>;
  deviceScaleFactor: number;
  dimensions?: Readonly<{ theme?: string }>;
  expectedText?: string;
  readySelectors?: readonly string[];
}>;

/**
 * A context is only worth opening once per SCALE and THEME. Device scale and
 * colour scheme are fixed when a context is created, but a viewport is not, and
 * a fresh context starts with a cold HTTP cache — so one context per capture
 * re-downloads and re-parses the whole Storybook bundle every time, which is
 * minutes of wall clock and the reason a story can miss its readiness deadline.
 */
export function geometryReplayContextKey(capture: GeometryReplayCapture): string {
  return `${capture.deviceScaleFactor}|${capture.dimensions?.theme === 'dark' ? 'dark' : 'light'}`;
}

export async function openGeometryReplayContext(
  browser: Browser,
  capture: GeometryReplayCapture,
  blockedRequests: string[]
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: capture.viewport,
    deviceScaleFactor: capture.deviceScaleFactor,
    reducedMotion: 'reduce',
    colorScheme: capture.dimensions?.theme === 'dark' ? 'dark' : 'light',
  });
  await context.route(/https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === geometryStorybookOrigin) {
      await route.continue();
      return;
    }
    blockedRequests.push(url.href);
    await route.abort('blockedbyclient');
  });
  return context;
}

/**
 * Show the story a capture came from, at that capture's viewport and settled
 * the same way every other pass settles it. Shared by the gate walk, the
 * `--after` replay and the Y cards, so a card, a repair image and a ratchet
 * measurement are never taken against a differently composed page.
 */
export async function showGeometryCaptureStory(
  context: BrowserContext,
  capture: GeometryReplayCapture
): Promise<Page> {
  // A fresh PAGE per capture, inside the shared context: the context keeps the
  // HTTP cache warm, and a page that has loaded a dozen stories in a row runs
  // its renderer out of memory and crashes mid-navigation.
  const page = await context.newPage();
  await page.setViewportSize(capture.viewport);
  const response = await page.goto(
    `${geometryStorybookOrigin}/iframe.html?id=${capture.storyId}&viewMode=story${
      capture.storyGlobals ? `&globals=${capture.storyGlobals}` : ''
    }`
  );
  if (!response?.ok()) throw new Error(`Story capture failed: ${capture.storyId}`);
  if (capture.storyId.includes('sessionconversationpage')) {
    await waitForSessionConversationStory(page);
  }
  await enableGeometryCaptureMode(page);
  for (const selector of capture.readySelectors ?? []) {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout: 60_000 });
  }
  if (capture.expectedText) {
    await page
      .getByText(capture.expectedText, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  }
  if (capture.dimensions?.theme === 'dark') {
    const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    if (!isDark) throw new Error(`${capture.storyId} did not apply the dark theme global`);
  }
  if (capture.storyId.startsWith('geometry-chatworkspace--')) {
    await measureSettledChatWorkspace(page);
  } else {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
  }
  return page;
}

export type GeometryPlanObservation = Readonly<{
  entry: GeometryCapturePlanEntry;
  railDiscovery: readonly BrowserAlignmentRailDiscoveryScope[];
  semanticAlignments?: readonly BrowserSemanticAlignmentEntry[];
  semanticBaselines?: readonly BrowserSemanticBaselineEntry[];
}>;

/**
 * Run discovery on an already-settled page for one plan entry. The gate and the
 * report both come through here, so neither can pass discovery a scope, a
 * capture id or a surface family the other does not.
 */
export async function observeGeometryPlanEntry(
  page: Page,
  entry: GeometryCapturePlanEntry,
  observationCache?: GeometryObservationCache
): Promise<GeometryPlanObservation> {
  const railDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
    aggregateScopes: entry.aggregateScopes,
    captureId: entry.captureId,
    surfaceFamily: entry.area,
    ...(observationCache ? { observationCache } : {}),
  });
  if (!entry.semanticObservations) return { entry, railDiscovery };
  return {
    entry,
    railDiscovery,
    semanticAlignments: await auditChatWorkspaceSemanticAlignments(page),
    semanticBaselines: await auditChatWorkspaceSemanticBaselines(page),
  };
}

/** One capture record, assembled the same way for the report and for the gate. */
export function buildGeometryCapture(
  observation: GeometryPlanObservation,
  screenshot = ''
): GeometryCapture {
  const { entry, railDiscovery } = observation;
  const boxModelNodes = Object.assign(
    {},
    ...railDiscovery.map((scope) => scope.capturedScope.boxModelNodes ?? {})
  );
  const semanticMembers = (
    members: BrowserSemanticAlignmentEntry['members'] | BrowserSemanticBaselineEntry['members']
  ) =>
    members.map((member) => ({
      name: member.name,
      coordinate: member.coordinate,
      ...(member.primitiveId ? { primitiveId: member.primitiveId } : {}),
      rect: member.rect,
    }));
  const splitGroupLabel = (groupLabel: string) => {
    const [group, instance] = groupLabel.split(' · ');
    return { group: group ?? groupLabel, instance: instance ?? null };
  };
  return {
    captureId: entry.captureId,
    surfaceFamily: entry.area,
    surface: entry.surface,
    storyId: entry.storyId,
    viewport: entry.viewport,
    deviceScaleFactor: entry.deviceScaleFactor,
    dimensions: entry.dimensions,
    screenshot,
    scopes: railDiscovery.map((scope) => {
      const { boxModelNodes: _boxModelNodes, ...capturedScope } = scope.capturedScope;
      return capturedScope;
    }),
    boxModelNodes,
    ...(observation.semanticAlignments
      ? {
          semanticAlignments: observation.semanticAlignments.map((item) => ({
            ...splitGroupLabel(item.groupLabel),
            axis: item.axis,
            anchor: item.anchor,
            status: item.status,
            line: item.line,
            members: semanticMembers(item.members),
          })),
          // The baseline rules travel with the alignment rules so
          // marker-removal readiness asks one question of every marker.
          semanticBaselines: (observation.semanticBaselines ?? []).map((item) => ({
            ...splitGroupLabel(item.groupLabel),
            axis: 'y' as const,
            anchor: 'text-baseline' as const,
            status: item.status,
            line: item.line,
            members: semanticMembers(item.members),
          })),
        }
      : {}),
  };
}

/**
 * Walk the plan and return the capture artifact. `onObserved` is where the
 * report takes its screenshots; the gate passes nothing, which is the whole
 * difference between a 40-minute review run and a CI ratchet.
 */
export async function runGeometryCapturePlan(
  browser: Browser,
  entries: readonly GeometryCapturePlanEntry[],
  options: Readonly<{
    observationCache?: GeometryObservationCache;
    blockedRequests?: string[];
    onObserved?: (page: Page, observation: GeometryPlanObservation) => Promise<void>;
  }> = {}
): Promise<GeometryCaptureArtifact> {
  const blockedRequests = options.blockedRequests ?? [];
  const contexts = new Map<string, BrowserContext>();
  const captures: GeometryCapture[] = [];
  try {
    for (const entry of entries) {
      const contextKey = geometryReplayContextKey(entry);
      let context = contexts.get(contextKey);
      if (!context) {
        context = await openGeometryReplayContext(browser, entry, blockedRequests);
        contexts.set(contextKey, context);
      }
      const page = await showGeometryCaptureStory(context, entry);
      try {
        const observation = await observeGeometryPlanEntry(page, entry, options.observationCache);
        captures.push(buildGeometryCapture(observation));
        await options.onObserved?.(page, observation);
      } finally {
        await page.close();
      }
    }
  } finally {
    for (const context of contexts.values()) await context.close().catch(() => undefined);
  }
  if (blockedRequests.length > 0 && !options.blockedRequests) {
    throw new Error(`Unexpected network requests: ${blockedRequests.join(', ')}`);
  }
  return { version: 1, captures };
}

export type GeometryPipelineArtifacts = Readonly<{
  capture: GeometryCaptureArtifact;
  observation: GeometryObservationArtifact;
  findings: GeometryFindingArtifact;
}>;

/**
 * `capture → observation → findings`, each stage reading only the previous.
 * The report writes the three files; the gate keeps them in memory. Nothing
 * else may re-derive a finding, or the ratchet would enforce a number the
 * review never saw.
 */
export function runGeometryFindingPipeline(
  capture: GeometryCaptureArtifact
): GeometryPipelineArtifacts {
  const observation = observeGeometryCaptures(capture);
  return { capture, observation, findings: createGeometryFindings(capture, observation) };
}
