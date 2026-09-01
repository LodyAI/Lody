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
const storybookOrigin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:6006';

type ReportDetail = Readonly<{
  kind: 'violation' | 'candidate' | 'jitter' | 'insufficient';
  requiresReview: boolean;
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
      measurement?: string;
      layout?: 'target-row' | 'gutter-list';
      tone?: 'violation' | 'candidate' | 'jitter';
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

function reportDetailPriority(detail: ReportDetail): number {
  if (detail.kind === 'violation') return 0;
  if (detail.kind === 'candidate' && detail.requiresReview) return 1;
  if (detail.kind === 'insufficient') return 2;
  if (detail.kind === 'jitter') return 3;
  return 4;
}

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

const DISCOVERY_SCOPE_LABELS: Readonly<Record<string, string>> = {
  'main.chat-landing': 'Chat Landing 主内容区',
  'session.messages': '消息列表',
  'session.page': '会话页整体',
  'session.permission': '权限确认区',
  'sidebar.group:__only_chats__': 'Sidebar Chats 会话分组',
  'sidebar.local-projects:geometry': 'Sidebar 本地项目与会话列表',
  'sidebar.shell': 'Sidebar 整体工作区',
};

const DISCOVERY_SURFACE_LABELS: Readonly<Record<string, string>> = {
  'Chat Session / Agent Question': 'Chat Session / Agent 提问态',
  'Chat Session / Idle': 'Chat Session / 空闲态',
  'Chat Session / Mention Drop': 'Chat Session / 会话引用拖放态',
  'Chat Session / Permission': 'Chat Session / 权限确认态',
  'Chat Session / Working': 'Chat Session / 工作态（冻结帧）',
  'Workspace / Chat Landing': 'Workspace / Chat Landing',
};

const DISCOVERY_ELEMENT_LABELS: Readonly<Record<string, string>> = {
  'Import local project folder': '分区尾部按钮',
  'New session': '新建会话按钮',
  'Remove project': '项目尾部按钮',
  'local-session-title-ink': '会话标题视觉墨迹',
  'project-label': '项目标题',
  'project-leading-control': '项目文件夹图标',
  'project-trailing-action': '项目尾部按钮',
  'section-trailing-action': '分区尾部按钮',
  'Turn configuration': '会话配置控件',
  Worktree: 'Worktree 标记',
};

const DISCOVERY_ANCHOR_LABELS = {
  'inline-start': '左缘',
  'inline-center': '中心',
  'inline-end': '右缘',
} as const;

function discoveryScopeLabel(scope: BrowserAlignmentRailDiscoveryScope): string {
  if (scope.source === 'auto') {
    return `自动发现的重复结构（${scope.topology?.instanceCount ?? 0} 项）`;
  }
  return DISCOVERY_SCOPE_LABELS[scope.scope] ?? scope.scope;
}

function discoverySurfaceLabel(surface: string): string {
  return DISCOVERY_SURFACE_LABELS[surface] ?? surface;
}

function discoveryElementLabel(elementId: string, rowId: string, coordinate: number): string {
  const rawLabel = elementId.replace(/^\d+(?:\.\d+)?:/, '');
  if (rawLabel === 'svg') {
    if (rowId.includes('sidebar-')) {
      return coordinate > 160 ? '会话行尾图标' : '会话行首图标';
    }
    return '图标';
  }
  return DISCOVERY_ELEMENT_LABELS[rawLabel] ?? semanticMemberLabel(rawLabel);
}

type DiscoveryOutlier = Readonly<{
  elementId: string;
  rowId: string;
  anchor: 'inline-start' | 'inline-center' | 'inline-end';
  coordinate: number;
  yStart: number;
  yEnd: number;
  delta: number;
}>;

function groupDiscoveryOutliers(scope: BrowserAlignmentRailDiscoveryScope): readonly Readonly<{
  label: string;
  measurement: string;
  representative: DiscoveryOutlier;
  line: number;
}>[] {
  const elements = new Map<
    string,
    Array<Readonly<{ member: DiscoveryOutlier; line: number; offset: number }>>
  >();
  for (const rail of scope.rails) {
    for (const member of rail.outliers) {
      const key = `${member.rowId}\u0000${member.elementId}`;
      const entries = elements.get(key) ?? [];
      entries.push({ member, line: rail.line, offset: member.coordinate - rail.line });
      elements.set(key, entries);
    }
  }

  return Array.from(elements.values()).map((entries) => {
    const byOffset = new Map<string, { offset: number; anchors: string[] }>();
    for (const { member, offset } of entries) {
      const offsetKey = offset.toFixed(2);
      const group = byOffset.get(offsetKey) ?? { offset, anchors: [] };
      group.anchors.push(DISCOVERY_ANCHOR_LABELS[member.anchor]);
      byOffset.set(offsetKey, group);
    }
    const measurement = Array.from(byOffset.values())
      .map(({ offset, anchors }) => `${anchors.join('/')} ${formatDirectionalOffset('x', offset)}`)
      .join(' / ');
    const strongest = [...entries].sort(
      (left, right) => Math.abs(right.offset) - Math.abs(left.offset)
    )[0];
    if (!strongest) throw new Error('Discovery outlier group is unexpectedly empty');
    return {
      label: discoveryElementLabel(
        strongest.member.elementId,
        strongest.member.rowId,
        strongest.member.coordinate
      ),
      measurement,
      representative: strongest.member,
      line: strongest.line,
    };
  });
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
    await workspace.evaluate((element) =>
      element.setAttribute('data-geometry-actions-visible', 'true')
    );
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
            background: 'rgb(14 116 144 / 0.24)',
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
            background: 'rgb(14 116 144 / 0.5)',
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
            background: 'rgb(217 119 6 / 0.9)',
          });
          const marker = document.createElement('div');
          Object.assign(marker.style, {
            position: 'absolute',
            left: `${member.coordinate - 1.5}px`,
            top: `${y - 3}px`,
            width: '3px',
            height: '7px',
            background: 'rgb(217 119 6 / 0.9)',
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

        const appendLeader = (
          fromX: number,
          fromY: number,
          toX: number,
          toY: number,
          accent: string
        ) => {
          const length = Math.hypot(toX - fromX, toY - fromY);
          const leader = document.createElement('div');
          Object.assign(leader.style, {
            position: 'absolute',
            left: `${fromX}px`,
            top: `${fromY}px`,
            width: `${length}px`,
            height: '1px',
            background: `rgb(${accent} / 0.72)`,
            transform: `rotate(${Math.atan2(toY - fromY, toX - fromX)}rad)`,
            transformOrigin: '0 50%',
          });
          overlay.append(leader);
        };

        annotations.forEach((annotation, index) => {
          const isWarmDiagnostic = annotation.tone === 'candidate' || annotation.tone === 'jitter';
          const accent = isWarmDiagnostic ? '217 119 6' : '37 99 235';
          const measurement =
            annotation.measurement ??
            `${
              annotation.axis === 'y'
                ? annotation.offset < 0
                  ? '↑'
                  : '↓'
                : annotation.offset < 0
                  ? '←'
                  : '→'
            }${Number(Math.abs(annotation.offset).toFixed(2))}px`;
          const text = `${index + 1}  ${annotation.label}  ${measurement}`;
          const maxLabelWidth = annotation.layout === 'gutter-list' ? 350 : 196;
          const estimatedTextWidth = Array.from(text).reduce(
            (width, character) => width + (character.charCodeAt(0) > 255 ? 11 : 7),
            20
          );
          const labelWidth = Math.min(maxLabelWidth, Math.max(112, estimatedTextWidth));
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
            annotation.layout === 'gutter-list'
              ? clip.y + 8 + index * (labelHeight + 4)
              : annotation.axis === 'y'
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
            background: `rgb(${accent} / 0.9)`,
            boxShadow: '0 0 0 0.5px rgb(255 255 255 / 0.9)',
          });

          const offsetConnector = document.createElement('div');
          Object.assign(offsetConnector.style, {
            position: 'absolute',
            left: `${annotation.axis === 'y' ? targetX - 0.75 : Math.min(annotation.line, annotation.coordinate)}px`,
            top: `${annotation.axis === 'y' ? Math.min(annotation.line, annotation.coordinate) : targetY - 0.75}px`,
            width: `${annotation.axis === 'y' ? 1.5 : Math.max(1, Math.abs(annotation.offset))}px`,
            height: `${annotation.axis === 'y' ? Math.max(1, Math.abs(annotation.offset)) : 1.5}px`,
            background: `rgb(${accent} / 0.92)`,
          });

          const targetDot = document.createElement('span');
          Object.assign(targetDot.style, {
            position: 'absolute',
            left: `${targetX - 2.5}px`,
            top: `${targetY - 2.5}px`,
            width: '5px',
            height: '5px',
            border: `1.5px solid rgb(${accent} / 0.96)`,
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
            border: `1px solid rgb(${accent} / 0.58)`,
            borderRadius: '4px',
            background: isWarmDiagnostic ? 'rgb(255 251 235 / 0.82)' : 'rgb(255 255 255 / 0.8)',
            color: isWarmDiagnostic ? '#78350f' : '#172554',
            font: '650 11px/14px ui-monospace, SFMono-Regular, Menlo, monospace',
            letterSpacing: '0',
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgb(15 23 42 / 0.14)',
          });
          label.textContent = text;

          const leaderX = Math.max(labelLeft, Math.min(labelLeft + labelWidth, targetX));
          const leaderY = Math.max(labelTop, Math.min(labelTop + labelHeight, targetY));
          appendLeader(leaderX, leaderY, targetX, targetY, accent);
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
    .filter((entry) => entry.status !== 'aligned')
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
      const kind =
        entry.status === 'violation'
          ? 'violation'
          : entry.status === 'sub-pixel-jitter'
            ? 'jitter'
            : 'insufficient';
      const finding =
        entry.status === 'violation'
          ? `FAIL · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px`
          : entry.status === 'sub-pixel-jitter'
            ? `SUB-PIXEL JITTER · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px · 不进入 gate`
            : `证据不足 · 仅 ${entry.members.length} 个可测元素`;
      return {
        kind,
        requiresReview: false,
        id,
        title: semanticAlignmentTitle(entry),
        description: `${contextText ? `“${contextText}” · ` : ''}${
          entry.axis === 'y' ? '视觉中心' : '水平位置'
        } · ${entry.members.length} 个元素`,
        finding,
        clip: sidebarAnnotationBand(
          sidebarCard,
          entry.rect,
          viewport,
          entry.axis === 'y' ? 46 : 18
        ),
        images: reportImages(id),
        overlay: {
          alignmentGroups: entry.measurable ? [entry.groupLabel] : [],
          baselineGroups: [],
          hoverActions: entry.groupLabel === 'sidebar.primary-trailing-rail-end',
          semanticAnnotations: entry.members
            .filter((member) => entry.measurable && member.delta > 0)
            .map((member) => ({
              label: semanticMemberLabel(member.name),
              axis: entry.axis,
              coordinate: member.coordinate,
              line: entry.line,
              offset: member.coordinate - entry.line,
              rect: member.rect,
              tone: entry.status === 'sub-pixel-jitter' ? ('jitter' as const) : undefined,
            })),
          discoveredRails: [],
        },
      };
    });
  const baselineDetails = semanticBaselines
    .filter((entry) => entry.status !== 'aligned')
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
      const kind =
        entry.status === 'violation'
          ? 'violation'
          : entry.status === 'sub-pixel-jitter'
            ? 'jitter'
            : 'insufficient';
      const finding =
        entry.status === 'violation'
          ? `FAIL · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px`
          : entry.status === 'sub-pixel-jitter'
            ? `SUB-PIXEL JITTER · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px · 不进入 gate`
            : `证据不足 · 仅 ${entry.members.length} 个可测元素`;
      return {
        kind,
        requiresReview: false,
        id,
        title: `Sidebar / ${instance}`,
        description: `text baseline · ${entry.members.map((member) => member.name).join(' ↔ ')}`,
        finding,
        clip: sidebarAnnotationBand(sidebarCard, entry.rect, viewport, 46),
        images: reportImages(id),
        overlay: {
          alignmentGroups: [],
          baselineGroups: entry.measurable ? [entry.groupLabel] : [],
          hoverActions: false,
          semanticAnnotations: entry.members
            .filter(() => entry.measurable)
            .map((member) => ({
              label: semanticMemberLabel(member.name),
              axis: 'y',
              coordinate: member.coordinate,
              line: entry.line,
              offset: member.coordinate - entry.line,
              rect: member.rect,
              tone: entry.status === 'sub-pixel-jitter' ? ('jitter' as const) : undefined,
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

    const railRegions = new Map<'leading' | 'middle' | 'trailing', typeof scope.rails>();
    for (const rail of scope.rails) {
      const position = (rail.line - scope.rect.x) / scope.rect.width;
      const region = position < 1 / 3 ? 'leading' : position > 2 / 3 ? 'trailing' : 'middle';
      railRegions.set(region, [...(railRegions.get(region) ?? []), rail]);
    }
    const regionLabels = {
      leading: '行首区',
      middle: '中部区',
      trailing: '尾部区',
    } as const;

    return Array.from(railRegions.entries()).map(([region, rails]): ReportDetail => {
      const groupedScope = { ...scope, rails };
      const id = `discovery-${idPrefix}-${scopeIndex + 1}-${region}`;
      const outliers = rails.flatMap((rail) => rail.outliers);
      const outlierGroups = groupDiscoveryOutliers(groupedScope);
      const maxOffset = Math.max(0, ...outliers.map((member) => member.delta));
      const finding =
        outliers.length > 0
          ? `候选 · ${outlierGroups.length} 个元素需要确认 · 最大偏移 ${Number(maxOffset.toFixed(2))}px`
          : '候选 · 当前轨道稳定';
      const hasAnnotations = outlierGroups.length > 0;
      const annotationGutter = hasAnnotations ? 400 : 0;

      return {
        kind: 'candidate',
        requiresReview: hasAnnotations,
        id,
        title: `${discoverySurfaceLabel(surface)} · ${discoveryScopeLabel(scope)} · ${regionLabels[region]}`,
        description: hasAnnotations
          ? `${rails.length} 条候选对齐轨 · ${outlierGroups.length} 个待确认元素`
          : `${rails.length} 条候选对齐轨 · 暂无偏离元素`,
        finding,
        clip: clampClip(
          {
            x: scope.rect.x - 8,
            y: scope.rect.y - 12,
            width: scope.rect.width + annotationGutter + 16,
            height: scope.rect.height + 24,
          },
          viewport
        ),
        images: reportImages(id),
        overlay: {
          alignmentGroups: [],
          baselineGroups: [],
          hoverActions: false,
          semanticAnnotations: outlierGroups.map(
            ({ label, measurement, representative, line }) => ({
              label,
              measurement,
              layout: 'gutter-list',
              tone: 'candidate',
              axis: 'x',
              coordinate: representative.coordinate,
              line,
              offset: representative.coordinate - line,
              rect: {
                x: representative.coordinate - 1,
                y: representative.yStart,
                width: 2,
                height: representative.yEnd - representative.yStart,
              },
            })
          ),
          discoveredRails: rails.map((rail) => ({
            line: rail.line,
            members: rail.members.map(({ coordinate, yStart, yEnd, outlier }) => ({
              coordinate,
              yStart,
              yEnd,
              outlier,
            })),
          })),
        },
      };
    });
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

async function enableReportCaptureMode(page: Page): Promise<void> {
  await expect(
    page.locator('[data-geometry-fixture-ready="true"], [data-testid="session-conversation-story"]')
  ).toBeAttached({ timeout: 30_000 });
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
  for (let index = 0; index < (await revealedSurfaces.count()); index += 1) {
    await expect(revealedSurfaces.nth(index)).toHaveCSS('opacity', '1');
  }
}

test.skip(!outputDirectory, 'Run through the geometry:report script');

test('captures the visual geometry report', async ({ browser }) => {
  test.setTimeout(300_000);
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
    if (url.origin === storybookOrigin) {
      await route.continue();
      return;
    }
    unexpectedNetworkRequests.push(url.href);
    await route.abort('blockedbyclient');
  });

  const page = await context.newPage();
  const cleanUrl = `${storybookOrigin}/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story`;
  const cleanResponse = await page.goto(cleanUrl);
  expect(cleanResponse?.ok()).toBeTruthy();
  await enableReportCaptureMode(page);
  const hoverActions = page.locator('[data-geometry-hover-action]');
  expect(await hoverActions.count()).toBeGreaterThan(0);
  expect(
    await hoverActions.evaluateAll((elements) =>
      elements.every((element) => getComputedStyle(element).opacity === '1')
    )
  ).toBe(true);

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
  const railDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
    aggregateScopes: ['sidebar.shell'],
  });
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
  const sidebarDiscovery = workspaceDiscoveryDetails.find(
    (detail) => detail.title.includes('Sidebar 整体工作区') && detail.title.includes('尾部区')
  );
  expect(sidebarDiscovery?.description).toMatch(/\b3 个待确认元素$/);
  expect(sidebarDiscovery?.overlay.semanticAnnotations).toHaveLength(3);
  expect(
    sidebarDiscovery?.overlay.discoveredRails.some((rail) => Math.abs(rail.line - 266) <= 0.5)
  ).toBe(true);
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

  const annotatedUrl = `${storybookOrigin}/iframe.html?id=geometry-chatworkspace--geometry-audit&viewMode=story`;
  const annotatedResponse = await page.goto(annotatedUrl);
  expect(annotatedResponse?.ok()).toBeTruthy();
  await enableReportCaptureMode(page);
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
      captureId: string;
      contractDomain: 'workspace' | 'session';
      surface: string;
      viewport: Readonly<{ width: number; height: number }>;
      railDiscovery: readonly BrowserAlignmentRailDiscoveryScope[];
    }>
  > = [
    {
      captureId: 'workspace:wide-expanded',
      contractDomain: 'workspace',
      surface: 'Workspace / Chat Landing',
      viewport,
      railDiscovery,
    },
  ];

  for (const verificationCase of CHAT_WORKSPACE_GEOMETRY_SPEC.verificationCases) {
    if (verificationCase.name === 'wide-expanded') continue;
    const matrixContext = await browser.newContext({
      viewport: verificationCase.viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });
    await matrixContext.route(/https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === storybookOrigin) {
        await route.continue();
        return;
      }
      unexpectedNetworkRequests.push(url.href);
      await route.abort('blockedbyclient');
    });
    const matrixPage = await matrixContext.newPage();
    const storyId =
      verificationCase.sidebar === 'expanded'
        ? 'geometry-chatworkspace--expanded-sidebar'
        : 'geometry-chatworkspace--collapsed-sidebar';
    const response = await matrixPage.goto(
      `${storybookOrigin}/iframe.html?id=${storyId}&viewMode=story`
    );
    expect(response?.ok()).toBeTruthy();
    await enableReportCaptureMode(matrixPage);
    await measureSettledChatWorkspace(matrixPage);
    const matrixDiscovery = await discoverChatWorkspaceAlignmentRails(matrixPage, {
      aggregateScopes: ['sidebar.shell'],
    });
    discoverySurfaces.push({
      captureId: `workspace:${verificationCase.name}`,
      contractDomain: 'workspace',
      surface: `Workspace / ${verificationCase.name}`,
      viewport: verificationCase.viewport,
      railDiscovery: matrixDiscovery,
    });
    await matrixContext.close();
  }
  const sessionDetails: ReportDetail[] = [];
  const sessionStories = [
    {
      surface: 'Chat Session / Idle',
      idPrefix: 'session-idle',
      storyId: 'sessions-sessionconversationpage--desktop-idle',
    },
    {
      surface: 'Chat Session / Working',
      idPrefix: 'session-working',
      storyId: 'sessions-sessionconversationpage--desktop-working-settled',
    },
    {
      surface: 'Chat Session / Permission',
      idPrefix: 'session-permission',
      storyId: 'sessions-sessionconversationpage--desktop-permission-approval',
    },
    {
      surface: 'Chat Session / Agent Question',
      idPrefix: 'session-question',
      storyId: 'sessions-sessionconversationpage--desktop-agent-question',
    },
    {
      surface: 'Chat Session / Mention Drop',
      idPrefix: 'session-mention-drop',
      storyId: 'sessions-sessionconversationpage--desktop-session-mention-drop',
    },
  ] as const;

  for (const story of sessionStories) {
    const response = await page.goto(
      `${storybookOrigin}/iframe.html?id=${story.storyId}&viewMode=story`
    );
    expect(response?.ok()).toBeTruthy();
    await waitForSessionConversationStory(page);
    await enableReportCaptureMode(page);
    if (story.idPrefix === 'session-working') {
      await expect(page.locator('[data-stream-phase="indicator-only"]')).toBeAttached();
    }
    if (story.idPrefix === 'session-permission') {
      const responseActionBar = page.locator(
        '[data-geometry-capture-reveal="true"]:has(.lucide-info)'
      );
      await expect(responseActionBar).toHaveCount(1);
      await expect(responseActionBar).toHaveCSS('opacity', '1');
    }
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
    discoverySurfaces.push({
      captureId: `${story.idPrefix}:1440x900`,
      contractDomain: 'session',
      surface: story.surface,
      viewport,
      railDiscovery: sessionRailDiscovery,
    });
  }

  const details = [...workspaceDetails, ...sessionDetails]
    .map((detail, sourceIndex) => ({ detail, sourceIndex }))
    .sort(
      (left, right) =>
        reportDetailPriority(left.detail) - reportDetailPriority(right.detail) ||
        left.sourceIndex - right.sourceIndex
    )
    .map(({ detail }) => detail);
  expect(details.length).toBeGreaterThan(0);
  const reviewCandidateIndexes = details.flatMap((detail, index) =>
    detail.kind === 'candidate' && detail.requiresReview ? [index] : []
  );
  const stableCandidateIndexes = details.flatMap((detail, index) =>
    detail.kind === 'candidate' && !detail.requiresReview ? [index] : []
  );
  expect(reviewCandidateIndexes.length).toBeGreaterThan(0);
  expect(stableCandidateIndexes.length).toBeGreaterThan(0);
  expect(Math.max(...reviewCandidateIndexes)).toBeLessThan(Math.min(...stableCandidateIndexes));
  const scopeKey = (
    contractDomain: 'workspace' | 'session',
    scope: BrowserAlignmentRailDiscoveryScope
  ) =>
    `${contractDomain}:${
      scope.topology ? `auto:${scope.topology.signature}` : `hint:${scope.scope}`
    }`;
  const contractCaptures = (['workspace', 'session'] as const).flatMap((contractDomain) => {
    const captures = discoverySurfaces.filter(
      (capture) => capture.contractDomain === contractDomain
    );
    const keys = new Set(
      captures.flatMap((capture) =>
        capture.railDiscovery.map((scope) => scopeKey(contractDomain, scope))
      )
    );
    return captures.flatMap((capture) =>
      Array.from(keys).map((key) => {
        const matchingScope = capture.railDiscovery
          .filter((scope) => scopeKey(contractDomain, scope) === key)
          .sort(
            (left, right) =>
              right.rails.length - left.rails.length || right.candidateCount - left.candidateCount
          )[0];
        return {
          captureId: capture.captureId,
          scopeKey: key,
          scopeRect: matchingScope?.rect ?? {
            x: 0,
            y: 0,
            width: capture.viewport.width,
            height: capture.viewport.height,
          },
          rails: matchingScope?.rails ?? [],
          railFamilies: matchingScope?.railFamilies ?? [],
        };
      })
    );
  });
  const contractProposals = inferAlignmentRailContractProposals(contractCaptures, {
    minConfidence: 0.35,
  });
  expect(contractProposals.length).toBeGreaterThan(0);
  expect(
    contractProposals.some(
      (proposal) =>
        proposal.scopeKey.startsWith('workspace:') &&
        proposal.evidence.captureIds.length >= 3 &&
        proposal.evidence.captureCoverage > 0.5
    )
  ).toBe(true);
  expect(
    contractProposals.some(
      (proposal) =>
        proposal.scopeKey.startsWith('session:') &&
        proposal.evidence.captureIds.length >= 3 &&
        proposal.evidence.captureCoverage > 0.5
    )
  ).toBe(true);

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
    details: details.map(
      ({ kind, requiresReview, id, title, description, finding, clip, images }) => ({
        kind,
        requiresReview,
        id,
        title,
        description,
        finding,
        clip,
        images,
      })
    ),
  };

  await writeFile(
    path.join(outputDirectory, 'report-data.json'),
    `${JSON.stringify(reportData, null, 2)}\n`,
    'utf8'
  );
  expect(unexpectedNetworkRequests).toEqual([]);
  await context.close();
});
