import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
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
}>;

function unionRects(rects: readonly GeometryRect[]): GeometryRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

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

function maxBaselineSpread(entries: readonly BrowserSemanticBaselineEntry[]): number {
  return Math.max(0, ...entries.map((entry) => entry.spread));
}

function createReportDetails({
  viewport,
  sidebarCard,
  mainPane,
  greetingRegion,
  conversationColumn,
  semanticAlignments,
  semanticBaselines,
}: Readonly<{
  viewport: Readonly<{ width: number; height: number }>;
  sidebarCard: GeometryRect;
  mainPane: GeometryRect;
  greetingRegion: GeometryRect;
  conversationColumn: GeometryRect;
  semanticAlignments: readonly BrowserSemanticAlignmentEntry[];
  semanticBaselines: readonly BrowserSemanticBaselineEntry[];
}>): readonly ReportDetail[] {
  const trailingRail = semanticAlignments.find(
    (entry) => entry.groupLabel === 'sidebar.primary-trailing-rail-end'
  );
  if (!trailingRail) throw new Error('Sidebar trailing-rail semantic group is missing');

  const localRows = semanticAlignments.filter(
    (entry) =>
      entry.groupLabel.includes('sidebar-section:') ||
      entry.groupLabel.includes('sidebar-local-project:') ||
      entry.groupLabel.includes('sidebar-local-session:')
  );
  const chatRows = semanticAlignments.filter(
    (entry) =>
      entry.groupLabel.includes('sidebar-group:') || entry.groupLabel.includes('sidebar-session:')
  );
  const sidebarTextBaselines = semanticBaselines.filter(
    (entry) =>
      entry.rect.x >= sidebarCard.x &&
      entry.rect.x + entry.rect.width <= sidebarCard.x + sidebarCard.width
  );
  if (localRows.length === 0 || chatRows.length === 0 || sidebarTextBaselines.length === 0) {
    throw new Error('Expected Sidebar semantic groups were not measured');
  }

  const localRowsRect = unionRects(localRows.map((entry) => entry.rect));
  const chatRowsRect = unionRects(chatRows.map((entry) => entry.rect));
  const sidebarTextRect = unionRects(sidebarTextBaselines.map((entry) => entry.rect));
  const greetingWidth = Math.min(760, mainPane.width - 48);
  const greetingHeight = Math.min(280, greetingRegion.height);
  const greetingClip = clampClip(
    {
      x: mainPane.x + (mainPane.width - greetingWidth) / 2,
      y: greetingRegion.y + (greetingRegion.height - greetingHeight) / 2,
      width: greetingWidth,
      height: greetingHeight,
    },
    viewport
  );
  const composerClip = clampClip(
    {
      x: conversationColumn.x - 28,
      y: conversationColumn.y - 28,
      width: conversationColumn.width + 56,
      height: conversationColumn.height + 56,
    },
    viewport
  );
  const makeImages = (id: string) => ({
    clean: `assets/detail-${id}-clean.png`,
    annotated: `assets/detail-${id}-annotated.png`,
  });

  return [
    {
      id: 'sidebar-trailing-rail',
      title: 'Sidebar / 尾部动作语义轨',
      description:
        '跨 section、project 与 session 的 trailing edge；主线是中位数，细线是各成员实测位置。',
      finding: `${trailingRail.aligned ? 'PASS' : 'FAIL'} · spread ${Number(trailingRail.spread.toFixed(2))}px · ${trailingRail.members.length} members`,
      clip: sidebarBand(sidebarCard, trailingRail.rect, viewport, 18),
      images: makeImages('sidebar-trailing-rail'),
    },
    {
      id: 'sidebar-local-rows',
      title: 'Sidebar / Local Projects 行内中心',
      description:
        '每个 row instance 独立比较 leading control、label 与 trailing action 的 block-center。',
      finding: `${localRows.filter((entry) => !entry.aligned).length} misaligned · ${localRows.length} semantic lines`,
      clip: sidebarBand(sidebarCard, localRowsRect, viewport, 20),
      images: makeImages('sidebar-local-rows'),
    },
    {
      id: 'sidebar-chat-rows',
      title: 'Sidebar / Chats 与 Session 行内中心',
      description: 'section label/action 与每条 session 的 leading、title、end slot 分组检查。',
      finding: `${chatRows.filter((entry) => !entry.aligned).length} misaligned · ${chatRows.length} semantic lines`,
      clip: sidebarBand(sidebarCard, chatRowsRect, viewport, 20),
      images: makeImages('sidebar-chat-rows'),
    },
    {
      id: 'sidebar-text-baselines',
      title: 'Sidebar / 文字 baseline',
      description: '仅比较同一文字语义组；图标不参与字体 baseline 判定。',
      finding: `${sidebarTextBaselines.filter((entry) => !entry.aligned).length} misaligned · max spread ${Number(maxBaselineSpread(sidebarTextBaselines).toFixed(2))}px`,
      clip: sidebarBand(sidebarCard, sidebarTextRect, viewport, 20),
      images: makeImages('sidebar-text-baselines'),
    },
    {
      id: 'chat-greeting-grid',
      title: 'Chat Landing / Greeting 网格定位',
      description: '检查主视觉中心与 Main Pane columns 的关系；这不是 Sidebar 语义线。',
      finding: '12-column reference',
      clip: greetingClip,
      images: makeImages('chat-greeting-grid'),
    },
    {
      id: 'chat-composer-grid',
      title: 'Chat Landing / Composer 版心',
      description: '检查 conversation column、composer 外沿与 Main Pane columns 的几何关系。',
      finding: `${Number(conversationColumn.width.toFixed(2))}px conversation column`,
      clip: composerClip,
      images: makeImages('chat-composer-grid'),
    },
  ];
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
  expect(semanticBaselines.every((entry) => Number.isFinite(entry.spread))).toBe(true);
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
  const greetingRegion = requireGeometryRect(
    measurement.snapshot,
    CHAT_WORKSPACE_GEOMETRY_ANCHORS.greetingRegion
  );
  const conversationColumn = requireGeometryRect(
    measurement.snapshot,
    CHAT_WORKSPACE_GEOMETRY_ANCHORS.conversationColumn
  );
  const details = createReportDetails({
    viewport,
    sidebarCard,
    mainPane,
    greetingRegion,
    conversationColumn,
    semanticAlignments,
    semanticBaselines,
  });

  const assetsDirectory = path.join(outputDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(assetsDirectory, 'chat-workspace-clean.png'),
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
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
  await spacingOverlay.evaluate((element) => {
    (element as HTMLElement).style.display = 'none';
  });
  await page.screenshot({
    path: path.join(assetsDirectory, 'chat-workspace-annotated.png'),
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  for (const detail of details) {
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
    geometryViolations,
    details,
    images: {
      clean: 'assets/chat-workspace-clean.png',
      annotated: 'assets/chat-workspace-annotated.png',
    },
  };

  await writeFile(
    path.join(outputDirectory, 'report-data.json'),
    `${JSON.stringify(reportData, null, 2)}\n`,
    'utf8'
  );
  expect(unexpectedNetworkRequests).toEqual([]);
  await context.close();
});
