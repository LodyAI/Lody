import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  type GeometryRect,
  validateChatWorkspaceGeometry,
} from '../../src/lib/chat-workspace-geometry';
import {
  auditChatWorkspaceSemanticAlignments,
  auditChatWorkspaceSemanticBaselines,
  auditChatWorkspaceSpacing,
  discoverChatWorkspaceAlignmentRails,
  type BrowserSemanticAlignmentEntry,
  type BrowserSemanticBaselineEntry,
  formatGeometryViolations,
  measureSettledChatWorkspace,
  requireGeometryRect,
} from './support/chat-workspace-geometry';

const outputDirectory = process.env.GEOMETRY_REPORT_OUTPUT_DIR;

type ReportDetail = Readonly<{
  id: string;
  title: string;
  description: string;
  finding: string;
  clip: GeometryRect;
  images: Readonly<{ clean: string; annotated: string }>;
  overlay: Readonly<{
    alignmentGroups: readonly string[];
    baselineGroups: readonly string[];
    hoverActions: boolean;
  }>;
}>;

function clampClip(rect: GeometryRect, viewport: Readonly<{ width: number; height: number }>) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function sidebarBand(
  sidebarCard: GeometryRect,
  focus: GeometryRect,
  viewport: Readonly<{ width: number; height: number }>,
  verticalPadding = 24
): GeometryRect {
  return clampClip(
    {
      x: sidebarCard.x - 8,
      y: focus.y - verticalPadding,
      width: sidebarCard.width + 16,
      height: focus.height + verticalPadding * 2,
    },
    viewport
  );
}

function formatSignedOffset(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${rounded}px`;
}

async function showOnlyDetailSemanticGuides(page: Page, detail: ReportDetail): Promise<void> {
  const workspace = page.locator(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  if (detail.overlay.hoverActions) {
    await workspace.evaluate((element) =>
      element.setAttribute('data-geometry-actions-visible', 'true')
    );
  } else {
    await workspace.evaluate((element) => element.removeAttribute('data-geometry-actions-visible'));
  }
  await page
    .locator('[data-geometry-devtool="semantic-alignments"] [data-geometry-alignment-name]')
    .evaluateAll(
      (elements, allowedGroups) => {
        for (const element of elements) {
          const name = element.getAttribute('data-geometry-alignment-name');
          (element as HTMLElement).style.display =
            name && allowedGroups.includes(name) ? 'block' : 'none';
        }
      },
      [...detail.overlay.alignmentGroups]
    );
  await page
    .locator('[data-geometry-devtool="semantic-baselines"] [data-geometry-baseline-name]')
    .evaluateAll(
      (elements, allowedGroups) => {
        for (const element of elements) {
          const name = element.getAttribute('data-geometry-baseline-name');
          (element as HTMLElement).style.display =
            name && allowedGroups.includes(name) ? 'block' : 'none';
        }
      },
      [...detail.overlay.baselineGroups]
    );
}

function createReportDetails({
  viewport,
  sidebarCard,
  semanticAlignments,
  semanticBaselines,
}: Readonly<{
  viewport: Readonly<{ width: number; height: number }>;
  sidebarCard: GeometryRect;
  semanticAlignments: readonly BrowserSemanticAlignmentEntry[];
  semanticBaselines: readonly BrowserSemanticBaselineEntry[];
}>): readonly ReportDetail[] {
  const makeImages = (id: string) => ({
    clean: `assets/detail-${id}-clean.png`,
    annotated: `assets/detail-${id}-annotated.png`,
  });
  const alignmentDetails = semanticAlignments
    .filter((entry) => entry.measurable && !entry.aligned)
    .map((entry, index): ReportDetail => {
      const memberOffsets = entry.members
        .filter((member) => member.delta > 0)
        .map((member) => `${member.name} ${formatSignedOffset(member.coordinate - entry.line)}`)
        .join(' · ');
      const id = `alignment-${index + 1}`;
      return {
        id,
        title:
          entry.groupLabel === 'sidebar.primary-trailing-rail-end'
            ? 'Sidebar / 尾部动作语义轨'
            : entry.groupLabel,
        description: `${entry.axis.toUpperCase()} axis · ${entry.anchor} · ${entry.members.length} members`,
        finding: `FAIL · ${memberOffsets} · spread ${Number(entry.spread.toFixed(2))}px`,
        clip: sidebarBand(sidebarCard, entry.rect, viewport, 18),
        images: makeImages(id),
        overlay: {
          alignmentGroups: [entry.groupLabel],
          baselineGroups: [],
          hoverActions: entry.groupLabel === 'sidebar.primary-trailing-rail-end',
        },
      };
    });
  const baselineDetails = semanticBaselines
    .filter((entry) => !entry.aligned)
    .map((entry, index): ReportDetail => {
      const id = `text-baseline-${index + 1}`;
      const instance = entry.groupLabel.split(' · ').at(-1) ?? entry.groupLabel;
      const memberOffsets = entry.members
        .map((member) => `${member.name} ${formatSignedOffset(member.coordinate - entry.line)}`)
        .join(' · ');
      return {
        id,
        title: `Sidebar / ${instance}`,
        description: `text baseline · ${entry.members.map((member) => member.name).join(' ↔ ')}`,
        finding: `FAIL · ${memberOffsets} · spread ${Number(entry.spread.toFixed(2))}px`,
        clip: sidebarBand(sidebarCard, entry.rect, viewport, 14),
        images: makeImages(id),
        overlay: {
          alignmentGroups: [],
          baselineGroups: [entry.groupLabel],
          hoverActions: false,
        },
      };
    });
  const details = [...alignmentDetails, ...baselineDetails];
  if (details.length === 0) throw new Error('No semantic-guide violations were measured');
  return details;
}

test.skip(!outputDirectory, 'Run through the geometry:report script');

test('captures the visual geometry report', async ({ browser }) => {
  test.setTimeout(60_000);
  if (!outputDirectory) throw new Error('GEOMETRY_REPORT_OUTPUT_DIR is required');

  const viewport = { width: 1440, height: 900 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  const unexpectedNetworkRequests: string[] = [];
  await context.route(/https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:6006') {
      await route.continue();
      return;
    }
    unexpectedNetworkRequests.push(url.href);
    await route.abort('blockedbyclient');
  });

  const page = await context.newPage();
  const cleanUrl =
    'http://127.0.0.1:6006/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story';
  const cleanResponse = await page.goto(cleanUrl);
  expect(cleanResponse?.ok()).toBeTruthy();

  const measurement = await measureSettledChatWorkspace(page);
  const geometryViolations = validateChatWorkspaceGeometry(measurement.snapshot, {
    sidebar: 'expanded',
    spacingMeasurements: measurement.spacingMeasurements,
  });
  expect(
    geometryViolations,
    `Geometry contract failed:\n${formatGeometryViolations(geometryViolations)}`
  ).toEqual([]);

  const spacingAudit = await auditChatWorkspaceSpacing(page);
  const semanticAlignments = await auditChatWorkspaceSemanticAlignments(page);
  const semanticBaselines = await auditChatWorkspaceSemanticBaselines(page);
  const railDiscovery = await discoverChatWorkspaceAlignmentRails(page);
  expect(semanticBaselines.every((entry) => Number.isFinite(entry.spread))).toBe(true);
  expect(railDiscovery.some((scope) => scope.rails.length > 0)).toBe(true);
  const mainPane = requireGeometryRect(
    measurement.snapshot,
    CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane
  );
  const sidebarCard = requireGeometryRect(
    measurement.snapshot,
    CHAT_WORKSPACE_GEOMETRY_ANCHORS.sidebarCard
  );
  const mainGrid = calculateMainPaneGrid(mainPane);
  const sidebarGrid = calculateSidebarGrid(sidebarCard);
  const details = createReportDetails({
    viewport,
    sidebarCard,
    semanticAlignments,
    semanticBaselines,
  });

  const assetsDirectory = path.join(outputDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  for (const detail of details) {
    await page.screenshot({
      path: path.join(outputDirectory, detail.images.clean),
      clip: detail.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
  }

  const annotatedUrl =
    'http://127.0.0.1:6006/iframe.html?id=geometry-chatworkspace--geometry-audit&viewMode=story';
  const annotatedResponse = await page.goto(annotatedUrl);
  expect(annotatedResponse?.ok()).toBeTruthy();
  await measureSettledChatWorkspace(page);
  const spacingOverlay = page.locator('[data-geometry-devtool="spacing-audit"]');
  await expect(spacingOverlay).toBeAttached();
  await expect
    .poll(async () =>
      Number(await spacingOverlay.getAttribute('data-geometry-spacing-violation-count'))
    )
    .toBe(spacingAudit.length);
  const semanticOverlay = page.locator('[data-geometry-devtool="semantic-baselines"]');
  await expect(semanticOverlay).toBeAttached();
  await expect
    .poll(async () =>
      Number(await semanticOverlay.getAttribute('data-geometry-baseline-group-count'))
    )
    .toBe(semanticBaselines.length);
  const alignmentOverlay = page.locator('[data-geometry-devtool="semantic-alignments"]');
  await expect(alignmentOverlay).toBeAttached();
  await expect
    .poll(async () =>
      Number(await alignmentOverlay.getAttribute('data-geometry-alignment-group-count'))
    )
    .toBe(semanticAlignments.length);
  await expect(page.locator('[data-geometry-devtool="reference-grid"]')).toBeVisible();
  await expect(page.locator('[data-geometry-grid-scope="sidebar"]')).toBeVisible();
  const visibleProductionRows = page.locator('[data-sidebar-session-id]:visible');
  const visibleProductionRowCount = await visibleProductionRows.count();
  expect(visibleProductionRowCount).toBeGreaterThan(0);
  await spacingOverlay.evaluate((element) => {
    (element as HTMLElement).style.display = 'none';
  });
  await page.locator('[data-geometry-devtool="reference-grid"]').evaluate((element) => {
    (element as HTMLElement).style.display = 'none';
  });
  for (const detail of details) {
    await showOnlyDetailSemanticGuides(page, detail);
    await expect(visibleProductionRows).toHaveCount(visibleProductionRowCount);
    await page.screenshot({
      path: path.join(outputDirectory, detail.images.annotated),
      clip: detail.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
  }

  const reportData = {
    generatedAt: new Date().toISOString(),
    viewport,
    spec: CHAT_WORKSPACE_GEOMETRY_SPEC,
    snapshot: measurement.snapshot,
    mainGrid,
    sidebarGrid,
    spacingAudit,
    semanticAlignments,
    semanticBaselines,
    railDiscovery,
    geometryViolations,
    details: details.map(({ id, title, description, finding, clip, images }) => ({
      id,
      title,
      description,
      finding,
      clip,
      images,
    })),
  };

  await writeFile(
    path.join(outputDirectory, 'report-data.json'),
    `${JSON.stringify(reportData, null, 2)}\n`,
    'utf8'
  );
  expect(unexpectedNetworkRequests).toEqual([]);
  await context.close();
});
