import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  inferAlignmentRailContractProposals,
  type GeometryRect,
  validateChatWorkspaceGeometry,
} from '../../src/lib/chat-workspace-geometry';
import {
  auditChatWorkspaceSemanticAlignments,
  auditChatWorkspaceSemanticBaselines,
  auditChatWorkspaceSpacing,
  discoverChatWorkspaceAlignmentRails,
  type BrowserAlignmentRailDiscoveryScope,
  type BrowserSemanticAlignmentEntry,
  type BrowserSemanticBaselineEntry,
  formatGeometryViolations,
  measureSettledChatWorkspace,
  requireGeometryRect,
} from './support/chat-workspace-geometry';

const outputDirectory = process.env.GEOMETRY_REPORT_OUTPUT_DIR;

type ReportDetail = Readonly<{
  kind: 'violation' | 'candidate';
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
    semanticAnnotations: readonly Readonly<{
      label: string;
      axis: 'x' | 'y';
      coordinate: number;
      line: number;
      offset: number;
      rect: GeometryRect;
    }>[];
    discoveredRails: readonly Readonly<{
      line: number;
      members: readonly Readonly<{
        coordinate: number;
        yStart: number;
        yEnd: number;
        outlier: boolean;
      }>[];
    }>[];
  }>;
}>;

function clampClip(rect: GeometryRect, viewport: Readonly<{ width: number; height: number }>) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function sidebarAnnotationBand(
  sidebarCard: GeometryRect,
  focus: GeometryRect,
  viewport: Readonly<{ width: number; height: number }>,
  verticalPadding: number
): GeometryRect {
  const annotationGutter = 240;
  return clampClip(
    {
      x: sidebarCard.x - 8,
      y: focus.y - verticalPadding,
      width: sidebarCard.width + annotationGutter + 16,
      height: focus.height + verticalPadding * 2,
    },
    viewport
  );
}

function formatSignedOffset(value: number): string {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${rounded}px`;
}

const SEMANTIC_MEMBER_LABELS: Readonly<Record<string, string>> = {
  'group-new-action': '新建会话按钮',
  'leading-indicator-ink': '左侧状态图标',
  'leading-slot': '行首图标位',
  'local-session-title-ink': '项目会话标题',
  'project-trailing-action': '项目尾部按钮',
  'section-label': '分区标题',
  'section-trailing-action': '分区尾部按钮',
  'session-time-ink': '会话时间',
  'session-title-ink': '会话标题',
  'sidebar-filter-trigger': '筛选按钮',
  'trailing-slot': '行尾操作位',
};

function semanticMemberLabel(name: string): string {
  return SEMANTIC_MEMBER_LABELS[name] ?? name.replaceAll('-', ' ');
}

function formatDirectionalOffset(axis: 'x' | 'y', value: number): string {
  const rounded = Number(Math.abs(value).toFixed(2));
  const direction = axis === 'y' ? (value < 0 ? '↑' : '↓') : value < 0 ? '←' : '→';
  return `${direction}${rounded}px`;
}

function semanticAlignmentTitle(entry: BrowserSemanticAlignmentEntry): string {
  if (entry.groupLabel === 'sidebar.primary-trailing-rail-end') {
    return 'Sidebar / 尾部动作语义轨';
  }
  if (entry.groupLabel.includes('sidebar-local-session:')) {
    return 'Sidebar / 项目会话行视觉中心';
  }
  if (entry.groupLabel.includes('sidebar-session:')) {
    return 'Sidebar / 会话行视觉中心';
  }
  return entry.groupLabel;
}

function reportImages(id: string) {
  return {
    clean: `assets/detail-${id}-clean.png`,
    annotated: `assets/detail-${id}-annotated.png`,
  };
}

async function showOnlyDetailSemanticGuides(page: Page, detail: ReportDetail): Promise<void> {
  await page
    .locator('[data-geometry-report-discovery-overlay], [data-geometry-report-annotation-overlay]')
    .evaluateAll((elements) => {
      elements.forEach((element) => element.remove());
    });
  const workspace = page.locator(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  if ((await workspace.count()) > 0) {
    if (detail.overlay.hoverActions) {
      await workspace.evaluate((element) =>
        element.setAttribute('data-geometry-actions-visible', 'true')
      );
    } else {
      await workspace.evaluate((element) =>
        element.removeAttribute('data-geometry-actions-visible')
      );
    }
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
  if (detail.overlay.discoveredRails.length > 0) {
    await page.evaluate((rails) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-geometry-report-discovery-overlay', '');
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2147483646',
      });
      for (const rail of rails) {
        const orderedMembers = [...rail.members].sort(
          (left, right) => left.yStart - right.yStart || left.yEnd - right.yEnd
        );
        const centers = orderedMembers.map(
          (member) => member.yStart + (member.yEnd - member.yStart) / 2
        );
        const gaps = centers
          .slice(1)
          .map((center, index) => center - (centers[index] ?? center))
          .sort((left, right) => left - right);
        const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
        const segmentGap = Math.max(48, medianGap * 2.25);
        const segments: Array<typeof orderedMembers> = [];
        for (const member of orderedMembers) {
          const segment = segments.at(-1);
          const previous = segment?.at(-1);
          if (
            !segment ||
            !previous ||
            member.yStart + member.yEnd - previous.yStart - previous.yEnd <= segmentGap * 2
          ) {
            if (segment) segment.push(member);
            else segments.push([member]);
          } else {
            segments.push([member]);
          }
        }
        for (const segment of segments) {
          const yStart = Math.min(...segment.map((member) => member.yStart));
          const yEnd = Math.max(...segment.map((member) => member.yEnd));
          const line = document.createElement('div');
          Object.assign(line.style, {
            position: 'absolute',
            left: `${rail.line}px`,
            top: `${yStart}px`,
            width: '1.5px',
            height: `${Math.max(1, yEnd - yStart)}px`,
            background: 'rgb(244 63 94 / 0.58)',
            boxShadow: '0 0 0 0.5px rgb(255 255 255 / 0.58)',
          });
          overlay.append(line);
        }
        for (const member of rail.members.filter((candidate) => !candidate.outlier)) {
          const y = member.yStart + (member.yEnd - member.yStart) / 2;
          const tick = document.createElement('div');
          Object.assign(tick.style, {
            position: 'absolute',
            left: `${rail.line - 2}px`,
            top: `${y - 0.75}px`,
            width: '5.5px',
            height: '1.5px',
            background: 'rgb(244 63 94 / 0.86)',
          });
          overlay.append(tick);
        }
        for (const member of rail.members.filter((candidate) => candidate.outlier)) {
          const y = member.yStart + (member.yEnd - member.yStart) / 2;
          const connector = document.createElement('div');
          Object.assign(connector.style, {
            position: 'absolute',
            left: `${Math.min(rail.line, member.coordinate)}px`,
            top: `${y}px`,
            width: `${Math.max(1, Math.abs(member.coordinate - rail.line))}px`,
            height: '1.5px',
            background: 'rgb(244 63 94 / 0.9)',
          });
          const marker = document.createElement('div');
          Object.assign(marker.style, {
            position: 'absolute',
            left: `${member.coordinate - 1.5}px`,
            top: `${y - 3}px`,
            width: '3px',
            height: '7px',
            background: 'rgb(244 63 94 / 0.9)',
          });
          overlay.append(connector, marker);
        }
      }
      document.body.append(overlay);
    }, detail.overlay.discoveredRails);
  }
  if (detail.overlay.semanticAnnotations.length > 0) {
    await page.evaluate(
      ({ annotations, clip }) => {
        const overlay = document.createElement('div');
        overlay.setAttribute('data-geometry-report-annotation-overlay', '');
        Object.assign(overlay.style, {
          position: 'fixed',
          inset: '0',
          pointerEvents: 'none',
          zIndex: '2147483647',
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        });

        const appendLeader = (fromX: number, fromY: number, toX: number, toY: number) => {
          const length = Math.hypot(toX - fromX, toY - fromY);
          const leader = document.createElement('div');
          Object.assign(leader.style, {
            position: 'absolute',
            left: `${fromX}px`,
            top: `${fromY}px`,
            width: `${length}px`,
            height: '1px',
            background: 'rgb(37 99 235 / 0.72)',
            transform: `rotate(${Math.atan2(toY - fromY, toX - fromX)}rad)`,
            transformOrigin: '0 50%',
          });
          overlay.append(leader);
        };

        annotations.forEach((annotation, index) => {
          const text = `${index + 1}  ${annotation.label}  ${
            annotation.axis === 'y'
              ? annotation.offset < 0
                ? '↑'
                : '↓'
              : annotation.offset < 0
                ? '←'
                : '→'
          }${Number(Math.abs(annotation.offset).toFixed(2))}px`;
          const labelWidth = Math.min(196, Math.max(112, text.length * 7 + 20));
          const labelHeight = 22;
          const targetX =
            annotation.axis === 'y'
              ? annotation.rect.width > 80
                ? annotation.rect.x + 12
                : annotation.rect.x + annotation.rect.width / 2
              : annotation.coordinate;
          const targetY =
            annotation.axis === 'y'
              ? annotation.coordinate
              : annotation.rect.y + annotation.rect.height / 2;
          const labelLeft = Math.max(4, clip.x + clip.width - labelWidth - 8);
          const labelTop =
            annotation.axis === 'y'
              ? annotation.rect.y +
                annotation.rect.height / 2 -
                (annotations.length * labelHeight + (annotations.length - 1) * 4) / 2 +
                index * (labelHeight + 4)
              : annotation.rect.y + annotation.rect.height / 2 - labelHeight / 2;

          const actualAnchor = document.createElement('div');
          actualAnchor.setAttribute('data-geometry-report-member-anchor', annotation.label);
          Object.assign(actualAnchor.style, {
            position: 'absolute',
            left: `${annotation.axis === 'y' ? annotation.rect.x - 2 : annotation.coordinate - 1}px`,
            top: `${annotation.axis === 'y' ? annotation.coordinate - 1 : annotation.rect.y - 2}px`,
            width: `${annotation.axis === 'y' ? annotation.rect.width + 4 : 2}px`,
            height: `${annotation.axis === 'y' ? 2 : annotation.rect.height + 4}px`,
            background: 'rgb(37 99 235 / 0.9)',
            boxShadow: '0 0 0 0.5px rgb(255 255 255 / 0.9)',
          });

          const offsetConnector = document.createElement('div');
          Object.assign(offsetConnector.style, {
            position: 'absolute',
            left: `${annotation.axis === 'y' ? targetX - 0.75 : Math.min(annotation.line, annotation.coordinate)}px`,
            top: `${annotation.axis === 'y' ? Math.min(annotation.line, annotation.coordinate) : targetY - 0.75}px`,
            width: `${annotation.axis === 'y' ? 1.5 : Math.max(1, Math.abs(annotation.offset))}px`,
            height: `${annotation.axis === 'y' ? Math.max(1, Math.abs(annotation.offset)) : 1.5}px`,
            background: 'rgb(37 99 235 / 0.92)',
          });

          const targetDot = document.createElement('span');
          Object.assign(targetDot.style, {
            position: 'absolute',
            left: `${targetX - 2.5}px`,
            top: `${targetY - 2.5}px`,
            width: '5px',
            height: '5px',
            border: '1.5px solid rgb(37 99 235 / 0.96)',
            borderRadius: '50%',
            background: 'rgb(255 255 255 / 0.72)',
          });

          const label = document.createElement('span');
          label.setAttribute('data-geometry-report-member-label', annotation.label);
          Object.assign(label.style, {
            position: 'absolute',
            left: `${labelLeft}px`,
            top: `${labelTop}px`,
            width: `${labelWidth}px`,
            height: `${labelHeight}px`,
            padding: '3px 6px',
            border: '1px solid rgb(37 99 235 / 0.58)',
            borderRadius: '4px',
            background: 'rgb(255 255 255 / 0.8)',
            color: '#172554',
            font: '650 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0',
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgb(15 23 42 / 0.14)',
          });
          label.textContent = text;

          const leaderX = Math.max(labelLeft, Math.min(labelLeft + labelWidth, targetX));
          const leaderY = Math.max(labelTop, Math.min(labelTop + labelHeight, targetY));
          appendLeader(leaderX, leaderY, targetX, targetY);
          overlay.append(actualAnchor, offsetConnector, targetDot, label);
        });
        document.body.append(overlay);
      },
      { annotations: detail.overlay.semanticAnnotations, clip: detail.clip }
    );
  }
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
  const alignmentDetails = semanticAlignments
    .filter((entry) => entry.measurable && !entry.aligned)
    .map((entry, index): ReportDetail => {
      const memberOffsets = entry.members
        .filter((member) => member.delta > 0)
        .map(
          (member) =>
            `${semanticMemberLabel(member.name)} ${formatDirectionalOffset(
              entry.axis,
              member.coordinate - entry.line
            )}`
        )
        .join(' · ');
      const id = `alignment-${index + 1}`;
      const contextText = entry.members.find(
        (member) => member.name.includes('title') && member.text
      )?.text;
      return {
        kind: 'violation',
        id,
        title: semanticAlignmentTitle(entry),
        description: `${contextText ? `“${contextText}” · ` : ''}${
          entry.axis === 'y' ? '视觉中心' : '水平位置'
        } · ${entry.members.length} 个元素`,
        finding: `FAIL · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px`,
        clip: sidebarAnnotationBand(
          sidebarCard,
          entry.rect,
          viewport,
          entry.axis === 'y' ? 46 : 18
        ),
        images: reportImages(id),
        overlay: {
          alignmentGroups: [entry.groupLabel],
          baselineGroups: [],
          hoverActions: entry.groupLabel === 'sidebar.primary-trailing-rail-end',
          semanticAnnotations: entry.members
            .filter((member) => member.delta > 0)
            .map((member) => ({
              label: semanticMemberLabel(member.name),
              axis: entry.axis,
              coordinate: member.coordinate,
              line: entry.line,
              offset: member.coordinate - entry.line,
              rect: member.rect,
            })),
          discoveredRails: [],
        },
      };
    });
  const baselineDetails = semanticBaselines
    .filter((entry) => !entry.aligned)
    .map((entry, index): ReportDetail => {
      const id = `text-baseline-${index + 1}`;
      const instance = entry.groupLabel.split(' · ').at(-1) ?? entry.groupLabel;
      const memberOffsets = entry.members
        .map(
          (member) =>
            `${semanticMemberLabel(member.name)} ${formatDirectionalOffset(
              'y',
              member.coordinate - entry.line
            )}`
        )
        .join(' · ');
      return {
        kind: 'violation',
        id,
        title: `Sidebar / ${instance}`,
        description: `text baseline · ${entry.members.map((member) => member.name).join(' ↔ ')}`,
        finding: `FAIL · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px`,
        clip: sidebarAnnotationBand(sidebarCard, entry.rect, viewport, 46),
        images: reportImages(id),
        overlay: {
          alignmentGroups: [],
          baselineGroups: [entry.groupLabel],
          hoverActions: false,
          semanticAnnotations: entry.members.map((member) => ({
            label: semanticMemberLabel(member.name),
            axis: 'y',
            coordinate: member.coordinate,
            line: entry.line,
            offset: member.coordinate - entry.line,
            rect: member.rect,
          })),
          discoveredRails: [],
        },
      };
    });
  return [...alignmentDetails, ...baselineDetails];
}

function createDiscoveryDetails({
  surface,
  idPrefix,
  viewport,
  railDiscovery,
}: Readonly<{
  surface: string;
  idPrefix: string;
  viewport: Readonly<{ width: number; height: number }>;
  railDiscovery: readonly BrowserAlignmentRailDiscoveryScope[];
}>): readonly ReportDetail[] {
  return railDiscovery.flatMap((scope, scopeIndex): readonly ReportDetail[] => {
    if (scope.rails.length === 0) return [];

    const id = `discovery-${idPrefix}-${scopeIndex + 1}`;
    const outliers = scope.rails.flatMap((rail) => rail.outliers);
    const maxOffset = Math.max(0, ...outliers.map((member) => member.delta));
    const finding =
      outliers.length > 0
        ? `CANDIDATE · ${outliers.length} offsets · max ${formatSignedOffset(maxOffset)}`
        : 'CANDIDATE · stable support · no offset';
    const scopeLabel =
      scope.source === 'auto'
        ? `Auto repeated region · ${scope.topology?.instanceCount ?? 0} instances`
        : scope.scope;
    const topologyEvidence = scope.topology
      ? ` · topology ${Number((scope.topology.confidence * 100).toFixed(1))}%`
      : '';

    return [
      {
        kind: 'candidate',
        id,
        title: `${surface} / ${scopeLabel}`,
        description:
          `${scope.rails.length} candidate rails · ${scope.candidateCount} anchors sampled` +
          ` · ${outliers.length} outliers${topologyEvidence}`,
        finding,
        clip: clampClip(
          {
            x: scope.rect.x - 8,
            y: scope.rect.y - 12,
            width: scope.rect.width + 16,
            height: scope.rect.height + 24,
          },
          viewport
        ),
        images: reportImages(id),
        overlay: {
          alignmentGroups: [],
          baselineGroups: [],
          hoverActions: false,
          semanticAnnotations: [],
          discoveredRails: scope.rails.map((rail) => ({
            line: rail.line,
            members: rail.members.map(({ coordinate, yStart, yEnd, outlier }) => ({
              coordinate,
              yStart,
              yEnd,
              outlier,
            })),
          })),
        },
      },
    ];
  });
}

async function waitForSessionConversationStory(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="session-conversation-story"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

test.skip(!outputDirectory, 'Run through the geometry:report script');

test('captures the visual geometry report', async ({ browser }) => {
  test.setTimeout(180_000);
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
  const semanticDetails = createReportDetails({
    viewport,
    sidebarCard,
    semanticAlignments,
    semanticBaselines,
  });
  const workspaceDiscoveryDetails = createDiscoveryDetails({
    surface: 'Workspace / Chat Landing',
    idPrefix: 'workspace',
    viewport,
    railDiscovery,
  });
  const workspaceDetails = [...semanticDetails, ...workspaceDiscoveryDetails];

  const assetsDirectory = path.join(outputDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  for (const detail of workspaceDetails) {
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
  for (const detail of workspaceDetails) {
    await showOnlyDetailSemanticGuides(page, detail);
    await expect(page.locator('[data-geometry-report-member-label]')).toHaveCount(
      detail.overlay.semanticAnnotations.length
    );
    for (const annotation of detail.overlay.semanticAnnotations) {
      await expect(
        page.locator(`[data-geometry-report-member-label="${annotation.label}"]`).first()
      ).toContainText(annotation.label);
    }
    await expect(visibleProductionRows).toHaveCount(visibleProductionRowCount);
    await page.screenshot({
      path: path.join(outputDirectory, detail.images.annotated),
      clip: detail.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
  }

  const discoverySurfaces: Array<
    Readonly<{
      surface: string;
      railDiscovery: readonly BrowserAlignmentRailDiscoveryScope[];
    }>
  > = [{ surface: 'Workspace / Chat Landing', railDiscovery }];
  const sessionDetails: ReportDetail[] = [];
  const sessionStories = [
    {
      surface: 'Chat Session / Idle',
      idPrefix: 'session-idle',
      storyId: 'sessions-sessionconversationpage--desktop-idle',
    },
    {
      surface: 'Chat Session / Permission',
      idPrefix: 'session-permission',
      storyId: 'sessions-sessionconversationpage--desktop-permission-approval',
    },
  ] as const;

  for (const story of sessionStories) {
    const response = await page.goto(
      `http://127.0.0.1:6006/iframe.html?id=${story.storyId}&viewMode=story`
    );
    expect(response?.ok()).toBeTruthy();
    await waitForSessionConversationStory(page);
    const sessionRailDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
      aggregateScopes: ['session.page'],
    });
    expect(sessionRailDiscovery.some((scope) => scope.scope.startsWith('session.'))).toBe(true);
    const storyDetails = createDiscoveryDetails({
      surface: story.surface,
      idPrefix: story.idPrefix,
      viewport,
      railDiscovery: sessionRailDiscovery,
    });
    expect(storyDetails.length).toBeGreaterThan(0);

    for (const detail of storyDetails) {
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.clean),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    for (const detail of storyDetails) {
      await showOnlyDetailSemanticGuides(page, detail);
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.annotated),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }

    sessionDetails.push(...storyDetails);
    discoverySurfaces.push({ surface: story.surface, railDiscovery: sessionRailDiscovery });
  }

  const details = [...workspaceDetails, ...sessionDetails];
  expect(details.length).toBeGreaterThan(0);
  const contractProposals = inferAlignmentRailContractProposals(
    discoverySurfaces.flatMap(({ surface, railDiscovery: scopes }) =>
      scopes.map((scope) => ({
        captureId: surface,
        scopeKey: scope.topology ? `auto:${scope.topology.signature}` : `hint:${scope.scope}`,
        scopeRect: scope.rect,
        rails: scope.rails,
      }))
    )
  );
  expect(contractProposals.length).toBeGreaterThan(0);

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
    discoverySurfaces,
    contractProposals,
    geometryViolations,
    details: details.map(({ kind, id, title, description, finding, clip, images }) => ({
      kind,
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
