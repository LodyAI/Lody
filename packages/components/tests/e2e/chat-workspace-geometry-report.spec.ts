import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';

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
  alignmentFindingKey,
  assessGeometryMarkerRemoval,
  collectAggregatedGeometryRowFamilies,
  compareMarkerAlignmentsToBlockRails,
  compileGeometryContracts,
  computeGeometryQualityMetrics,
  createGeometryFindings,
  diffGeometryFindings,
  geometryIdentityLocator,
  geometryLocatorMatches,
  observeGeometryCaptures,
  summarizeGeometryInkCenters,
  type GeometryCaptureArtifact,
  type GeometryCapturedCandidate,
  type GeometryFinding,
  type GeometryFindingArtifact,
  type GeometryFindingClassification,
  type GeometryFindingEvidence,
  type GeometryRowMember,
  type GeometryLedger,
  type GeometryLedgerStatus,
  type GeometryObservationCache,
  type GeometryRepairProposal,
} from '../../src/lib/geometry-constraint-system';
import {
  auditChatWorkspaceSemanticAlignments,
  auditChatWorkspaceSemanticBaselines,
  auditChatWorkspaceSpacing,
  discoverChatWorkspaceAlignmentRails,
  measureGeometryContractOpticalInsets,
  type BrowserAlignmentRailDiscoveryScope,
  type BrowserSemanticAlignmentEntry,
  type BrowserSemanticBaselineEntry,
  measureSettledChatWorkspace,
  requireGeometryRect,
} from './support/chat-workspace-geometry';

const outputDirectory = process.env.GEOMETRY_REPORT_OUTPUT_DIR;
const storybookOrigin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:6006';
const reportPhase = process.env.GEOMETRY_REPORT_PHASE ?? 'before';

type ReportDetail = Readonly<{
  kind: 'violation' | 'candidate' | 'overview' | 'jitter' | 'insufficient' | 'measurement-model';
  requiresReview: boolean;
  classification?: GeometryFindingClassification;
  findingKey?: string;
  /** How the ledger reviewed this finding, or how it moved since that review. */
  ledgerStatus?: GeometryLedgerStatus | 'changed';
  baselineOffset?: number;
  currentOffset?: number;
  captureCount?: number;
  totalCaptureCount?: number;
  dimensionSensitivity?: readonly string[];
  repairProposal?: string;
  inkCenterWitness?: string;
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
    /** Horizontal guides: one row median plus the ticks its members sit on. */
    blockGuides?: readonly Readonly<{
      line: number;
      xStart: number;
      xEnd: number;
      members: readonly Readonly<{
        coordinate: number;
        xStart: number;
        xEnd: number;
        outlier: boolean;
      }>[];
    }>[];
  }>;
}>;

type PersistedReportData = {
  afterCapturedAt?: string;
  coverage: {
    captures: Array<{
      captureId: string;
      storyId: string;
      storyGlobals?: string;
      viewport: Readonly<{ width: number; height: number }>;
      deviceScaleFactor: number;
      dimensions?: Readonly<{ theme: string; locale: string; density: string }>;
    }>;
  };
  details: Array<{
    id: string;
    captureId: string;
    clip: GeometryRect;
    images: { clean: string; annotated: string; after?: string };
  }>;
};

function reportDetailPriority(detail: ReportDetail): number {
  if (detail.kind === 'violation') return 0;
  if (detail.kind === 'candidate' && detail.requiresReview) return 1;
  if (detail.kind === 'overview') return 2;
  if (detail.kind === 'insufficient') return 3;
  if (detail.kind === 'jitter') return 4;
  if (detail.kind === 'measurement-model') return 5;
  return 5;
}

function clampClip(rect: GeometryRect, viewport: Readonly<{ width: number; height: number }>) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

async function collectGeometryPixelWitnesses(
  page: Page,
  outputDirectoryPath: string,
  captures: GeometryCaptureArtifact,
  contracts: ReturnType<typeof compileGeometryContracts>
) {
  const witnesses = [];
  for (const contract of contracts.contracts) {
    if ((contract.relation?.kind ?? 'coincident') !== 'coincident') continue;
    const capture = captures.captures.find(
      (candidate) => candidate.storyId === contract.story && candidate.screenshot
    );
    if (!capture) continue;
    const candidatePool = capture.scopes.flatMap((scope) => scope.candidates);
    const samples = contract.members.flatMap((member) => {
      const matches = candidatePool
        .filter(
          (candidate) =>
            candidate.anchor === contract.anchor &&
            geometryLocatorMatches(candidate.locator, member)
        )
        .filter(
          (candidate, index, candidates) =>
            candidates.findIndex((other) => other.primitiveId === candidate.primitiveId) === index
        );
      return (member.all ? matches : matches.slice(0, 1)).map((candidate) => ({
        label: candidate.label,
        coordinate: candidate.coordinate,
        yStart: candidate.yStart,
        yEnd: candidate.yEnd,
      }));
    });
    if (samples.length < 2) continue;
    // A FRESH page in the same context: by now the report's page has loaded
    // every captured story, and a renderer that has is one navigation from
    // crashing. The context keeps the bundle cached, so this costs nothing.
    const witnessPage = await page.context().newPage();
    const storyUrl = `${storybookOrigin}/iframe.html?id=${contract.story}&viewMode=story`;
    const storyResponse = await witnessPage.goto(storyUrl);
    if (!storyResponse?.ok()) throw new Error(`Witness story failed: ${contract.story}`);
    await enableReportCaptureMode(witnessPage);
    if (contract.story.startsWith('geometry-chatworkspace--')) {
      await measureSettledChatWorkspace(witnessPage);
    }
    const opticalInsets = await measureGeometryContractOpticalInsets(witnessPage, contract);
    const png = await readFile(path.join(outputDirectoryPath, capture.screenshot));
    const pixelSamples = await witnessPage.evaluate(
      async ({ dataUrl, deviceScaleFactor, samples: targets }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context is unavailable');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const differenceAt = (x: number, yStart: number, yEnd: number) => {
          let difference = 0;
          let count = 0;
          const left = Math.max(0, Math.min(canvas.width - 1, x - 1));
          const right = Math.max(0, Math.min(canvas.width - 1, x + 1));
          for (let y = yStart; y <= yEnd; y += 1) {
            const leftIndex = (y * canvas.width + left) * 4;
            const rightIndex = (y * canvas.width + right) * 4;
            difference +=
              Math.abs(pixels[leftIndex]! - pixels[rightIndex]!) +
              Math.abs(pixels[leftIndex + 1]! - pixels[rightIndex + 1]!) +
              Math.abs(pixels[leftIndex + 2]! - pixels[rightIndex + 2]!);
            count += 3;
          }
          return count > 0 ? difference / count : 0;
        };
        return targets.map((target) => {
          const expectedX = Math.round(target.coordinate * deviceScaleFactor);
          const yStart = Math.max(0, Math.round(target.yStart * deviceScaleFactor));
          const yEnd = Math.min(canvas.height - 1, Math.round(target.yEnd * deviceScaleFactor));
          const nearby = Array.from({ length: 9 }, (_, index) => expectedX + index - 4).map(
            (x) => ({ x, gradient: differenceAt(x, yStart, yEnd) })
          );
          const strongest = nearby.sort((left, right) => right.gradient - left.gradient)[0]!;
          const delta = (strongest.x - expectedX) / deviceScaleFactor;
          const strength = Math.min(1, strongest.gradient / 24);
          const proximity = Math.max(0, 1 - Math.abs(delta) / 3);
          return {
            ...target,
            pixelCoordinate: strongest.x / deviceScaleFactor,
            delta,
            confidence: strength * proximity,
          };
        });
      },
      {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        deviceScaleFactor: capture.deviceScaleFactor,
        samples,
      }
    );
    // Users perceive ink, not boxes: an icon rail can share a layout edge
    // exactly and still read as unaligned, so record every icon member's ink
    // centre against the group's median.
    const inkCenters = summarizeGeometryInkCenters(
      contract.name,
      opticalInsets.map((sample) => ({
        label: sample.label,
        description: sample.description,
        inkCenter: sample.inkCenter,
        containsSvg: sample.containsSvg,
      }))
    );
    witnesses.push({
      contract: contract.name,
      findingKey: contract.findingKey,
      story: contract.story,
      // The gate now compares layout boxes; ink and pixels stay observational.
      gate: false,
      space: 'ink' as const,
      confidence:
        pixelSamples.reduce((total, sample) => total + sample.confidence, 0) / pixelSamples.length,
      opticalInsets,
      ...(inkCenters ? { inkCenters } : {}),
      samples: pixelSamples,
    });
    await witnessPage.close();
  }
  return witnesses;
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

const CLASSIFICATION_LABELS: Readonly<Record<GeometryFindingClassification, string>> = {
  'css-defect': 'CSS 缺陷',
  'optical-residual': '视觉余量',
  structural: '结构性',
};

const BOX_MODEL_TERM_LABELS: Readonly<Record<string, string>> = {
  padding: 'padding',
  border: 'border',
  margin: 'margin',
  gap: 'gap',
};

function formatRepairProposal(proposal: GeometryRepairProposal): string {
  const edge = proposal.edge === 'inline-start' ? '起始边' : '结束边';
  const terms = proposal.terms
    .slice(0, 3)
    .map((term) => {
      const owner = term.side === 'member' ? '本项' : '参照';
      return `${BOX_MODEL_TERM_LABELS[term.term] ?? term.term} 本项 ${Number(
        term.memberValue.toFixed(2)
      )} vs 参照 ${Number(term.referenceValue.toFixed(2))}（Δ${Number(
        term.delta.toFixed(2)
      )}px；差值来自${owner}的 ${term.element}）`;
    })
    .join('；');
  return `修复建议（${edge}）：${terms}`;
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
  'session.side-panel': '右侧栏整体',
  'sidebar.group:__only_chats__': 'Sidebar Chats 会话分组',
  'sidebar.local-projects:geometry': 'Sidebar 本地项目与会话列表',
  'sidebar.shell': 'Sidebar 整体工作区',
};

const DISCOVERY_SURFACE_LABELS: Readonly<Record<string, string>> = {
  'Chat Session / Agent Question': 'Chat Session / Agent 提问态',
  'Chat Session / Idle': 'Chat Session / 空闲态',
  'Chat Session / Permission': 'Chat Session / 权限确认态',
  'Chat Session / Right Sidebar / Changes': 'Chat Session / 右侧栏变更列表',
  'Chat Session / Right Sidebar / Empty': 'Chat Session / 右侧栏空态',
  'Chat Session / Right Sidebar / Tabs': 'Chat Session / 右侧栏多标签态',
  'Chat Session / Working': 'Chat Session / 工作态（冻结帧）',
  'Workspace / Chat Landing': 'Workspace / Chat Landing',
  'Workspace / Chat Landing / Dark': 'Workspace / Chat Landing 暗色主题',
  'Workspace / Chat Landing / 中文': 'Workspace / Chat Landing 中文',
  'Workspace / Chat Landing / Long Model': 'Workspace / Chat Landing 长配置名',
  'Workspace / Chat Landing / No Agent': 'Workspace / Chat Landing 无 Agent 配置',
  'Workspace / Chat Landing / No Machine Download': 'Workspace / Chat Landing 未连接客户端',
  'Workspace / Chat Landing / No Machine Starting': 'Workspace / Chat Landing Daemon 启动态',
  'Workspace / Chat Landing / Pasted Text': 'Workspace / Chat Landing 长粘贴文本',
  'Workspace / Chat Landing / Submitting': 'Workspace / Chat Landing 提交中',
};

type GeometryCaptureDimensions = Readonly<{ theme: string; locale: string; density: string }>;

/** Storybook's own globals; there is no density global, so it stays constant. */
const DEFAULT_CAPTURE_DIMENSIONS: GeometryCaptureDimensions = {
  theme: 'light',
  locale: 'en',
  density: 'default',
};

/**
 * Dimensions vary ONE capture family rather than every story: they exist to show
 * whether a finding survives a theme or a locale, and a full matrix would
 * multiply the report runtime for evidence nobody reads.
 */
const WORKSPACE_DIMENSION_CAPTURES = [
  {
    id: 'wide-expanded-dark',
    surface: 'Workspace / Chat Landing / Dark',
    globals: 'theme:dark',
    colorScheme: 'dark' as const,
    dimensions: { ...DEFAULT_CAPTURE_DIMENSIONS, theme: 'dark' },
  },
  {
    id: 'wide-expanded-zh',
    surface: 'Workspace / Chat Landing / 中文',
    globals: 'locale:zh_CN',
    colorScheme: 'light' as const,
    dimensions: { ...DEFAULT_CAPTURE_DIMENSIONS, locale: 'zh_CN' },
    // A zh_CN capture that still rendered English strings would silently claim a
    // locale axis it never varied, so the capture asserts a translated label.
    // The Sidebar's Chats section header is the one this fixture translates.
    expectedText: '对话',
  },
] as const;

const WORKSPACE_STATE_CAPTURES = [
  {
    id: 'landing-submitting',
    surface: 'Workspace / Chat Landing / Submitting',
    storyId: 'geometry-chatworkspace--submission-pending',
  },
  {
    id: 'landing-no-machine-download',
    surface: 'Workspace / Chat Landing / No Machine Download',
    storyId: 'geometry-chatworkspace--no-machine-download',
  },
  {
    id: 'landing-no-machine-starting',
    surface: 'Workspace / Chat Landing / No Machine Starting',
    storyId: 'geometry-chatworkspace--no-machine-starting',
  },
  {
    id: 'landing-no-agent',
    surface: 'Workspace / Chat Landing / No Agent',
    storyId: 'geometry-chatworkspace--no-agent-config',
  },
  {
    id: 'landing-long-model',
    surface: 'Workspace / Chat Landing / Long Model',
    storyId: 'geometry-chatworkspace--long-model',
  },
  {
    id: 'landing-pasted-text',
    surface: 'Workspace / Chat Landing / Pasted Text',
    storyId: 'geometry-chatworkspace--pasted-text',
  },
] as const;

const SESSION_STATE_CAPTURES = [
  {
    id: 'session-idle',
    surface: 'Chat Session / Idle',
    storyId: 'sessions-sessionconversationpage--desktop-idle',
  },
  {
    id: 'session-working',
    surface: 'Chat Session / Working',
    storyId: 'sessions-sessionconversationpage--desktop-working-settled',
  },
  {
    id: 'session-permission',
    surface: 'Chat Session / Permission',
    storyId: 'sessions-sessionconversationpage--desktop-permission-approval',
  },
  {
    id: 'session-question',
    surface: 'Chat Session / Agent Question',
    storyId: 'sessions-sessionconversationpage--desktop-agent-question',
  },
] as const;

const RIGHT_SIDEBAR_STATE_CAPTURES = [
  {
    id: 'session-right-sidebar-changes',
    surface: 'Chat Session / Right Sidebar / Changes',
    storyId: 'sessions-sessionsidepaneltabbar--geometry-report',
  },
  {
    id: 'session-right-sidebar-tabs',
    surface: 'Chat Session / Right Sidebar / Tabs',
    storyId: 'sessions-sessionsidepaneltabbar--unified-tabs',
  },
  {
    id: 'session-right-sidebar-empty',
    surface: 'Chat Session / Right Sidebar / Empty',
    storyId: 'sessions-sessionsidepaneltabbar--empty-state',
  },
] as const;

const GEOMETRY_COVERAGE_EXCLUSIONS = [
  {
    surface: 'Chat Session / Mention Drop',
    storyId: 'sessions-sessionconversationpage--desktop-session-mention-drop',
    reason: 'Transient interaction is geometrically isomorphic to the captured idle session.',
  },
  {
    surface: 'Chat Session / Live Streaming',
    storyId: 'sessions-sessionconversationpage--desktop-streaming-working',
    reason:
      'Live timing is nondeterministic; the settled working frame captures its stable geometry.',
  },
  {
    surface: 'Chat Landing / Theme Variants',
    storyId: 'chat-chatlandingview--desktop-dark',
    reason:
      'Theme changes paint, not layout geometry; the production workspace composition is captured.',
  },
  {
    surface: 'Chat Landing / Keyboard Navigation',
    storyId: 'chat-chatlandingview--desktop-keyboard-nav',
    reason: 'Keyboard ownership does not change the static rendered geometry.',
  },
  {
    surface: 'Chat Workspace / Mobile',
    storyId: 'sessions-sessionconversationpage--mobile-idle',
    reason: 'Outside the authenticated desktop Web workspace scope with persistent left Sidebar.',
  },
] as const;

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
  'block-start': '上缘',
  'block-center': '盒中心',
  'block-end': '下缘',
  'visual-center': '视觉中心',
  'text-baseline': '文字基线',
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
  const rawLabel = elementId.replace(/^\d+(?:\.\d+)*:/, '');
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
  locator?: GeometryCapturedCandidate['locator'];
  naming?: GeometryCapturedCandidate['naming'];
  label?: string;
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
      const capturedMember = member as typeof member & Partial<GeometryCapturedCandidate>;
      const normalizedMember: DiscoveryOutlier = {
        ...member,
        ...(capturedMember.locator ? { locator: capturedMember.locator } : {}),
        ...(capturedMember.naming ? { naming: capturedMember.naming } : {}),
        ...(capturedMember.label ? { label: capturedMember.label } : {}),
      };
      const key = `${member.rowId}\u0000${member.elementId}`;
      const entries = elements.get(key) ?? [];
      entries.push({
        member: normalizedMember,
        line: rail.line,
        offset: member.coordinate - rail.line,
      });
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
  if ((detail.overlay.blockGuides ?? []).length > 0) {
    await page.evaluate((guides) => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-geometry-report-discovery-overlay', '');
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2147483646',
      });
      for (const guide of guides) {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: `${guide.xStart - 6}px`,
          top: `${guide.line}px`,
          width: `${Math.max(1, guide.xEnd - guide.xStart + 12)}px`,
          height: '1.5px',
          background: 'rgb(14 116 144 / 0.24)',
          boxShadow: '0 0 0 0.5px rgb(255 255 255 / 0.58)',
        });
        overlay.append(line);
        for (const member of guide.members) {
          const x = member.xStart + (member.xEnd - member.xStart) / 2;
          const tick = document.createElement('div');
          Object.assign(tick.style, {
            position: 'absolute',
            left: `${x - 0.75}px`,
            top: `${Math.min(guide.line, member.coordinate)}px`,
            width: '1.5px',
            height: `${Math.max(1, Math.abs(member.coordinate - guide.line))}px`,
            background: member.outlier ? 'rgb(217 119 6 / 0.9)' : 'rgb(14 116 144 / 0.5)',
          });
          const cap = document.createElement('div');
          Object.assign(cap.style, {
            position: 'absolute',
            left: `${x - 3}px`,
            top: `${member.coordinate - 0.75}px`,
            width: '6px',
            height: '1.5px',
            background: member.outlier ? 'rgb(217 119 6 / 0.9)' : 'rgb(14 116 144 / 0.5)',
          });
          overlay.append(tick, cap);
        }
      }
      document.body.append(overlay);
    }, detail.overlay.blockGuides ?? []);
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
  const nonAlignedEntries = semanticAlignments.filter((entry) => entry.status !== 'aligned');
  const systematicGroups = new Map<
    string,
    { signature: string; entries: BrowserSemanticAlignmentEntry[] }
  >();
  for (const entry of nonAlignedEntries) {
    const baseGroup = entry.groupLabel.split(' · ')[0] ?? entry.groupLabel;
    const signature = entry.members
      .map((member) => `${member.name}:${(member.coordinate - entry.line).toFixed(2)}`)
      .sort()
      .join('|');
    const existing = systematicGroups.get(baseGroup);
    if (!existing) {
      systematicGroups.set(baseGroup, { signature, entries: [entry] });
    } else if (existing.signature === signature) {
      existing.entries.push(entry);
    }
  }
  const systematicEntryCount = new Map(
    [...systematicGroups.entries()]
      .filter(([, group]) => group.entries.length >= 2)
      .map(([name, group]) => [name, group.entries.length])
  );
  const seenSystematicGroups = new Set<string>();
  const alignmentDetails = nonAlignedEntries
    .filter((entry) => {
      const baseGroup = entry.groupLabel.split(' · ')[0] ?? entry.groupLabel;
      if (!systematicEntryCount.has(baseGroup)) return true;
      if (seenSystematicGroups.has(baseGroup)) return false;
      seenSystematicGroups.add(baseGroup);
      return true;
    })
    .map((entry, index): ReportDetail => {
      const baseGroup = entry.groupLabel.split(' · ')[0] ?? entry.groupLabel;
      const systematicCount = systematicEntryCount.get(baseGroup) ?? 0;
      const measurementModel = systematicCount >= 2;
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
      const kind = measurementModel
        ? 'measurement-model'
        : entry.status === 'violation'
          ? 'violation'
          : entry.status === 'sub-pixel-jitter'
            ? 'jitter'
            : 'insufficient';
      const finding = measurementModel
        ? `测量模型分歧 · ${systematicCount} 个 instance 具有相同偏移 · 不算 violation`
        : entry.status === 'violation'
          ? `FAIL · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px`
          : entry.status === 'sub-pixel-jitter'
            ? `SUB-PIXEL JITTER · ${memberOffsets} · 两端差 ${Number(entry.spread.toFixed(2))}px · 不进入 gate`
            : `证据不足 · 仅 ${entry.members.length} 个可测元素`;
      return {
        kind,
        requiresReview: false,
        id,
        title: measurementModel ? `${baseGroup} · 测量模型` : semanticAlignmentTitle(entry),
        description: measurementModel
          ? `同一组件的 ${systematicCount} 个 instance 呈现完全相同的成员偏移`
          : `${contextText ? `“${contextText}” · ` : ''}${
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
              tone:
                measurementModel || entry.status === 'sub-pixel-jitter'
                  ? ('jitter' as const)
                  : undefined,
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
  const surfaceFamily = surface.startsWith('Chat Session / Right Sidebar')
    ? 'right-sidebar'
    : surface.startsWith('Chat Session')
      ? 'session'
      : 'workspace';
  // The same repeated-row rule findings.json uses, over this capture's scopes,
  // so a discovery card and its finding share one key.
  const localCapture: GeometryCaptureArtifact = {
    version: 1,
    captures: [
      {
        captureId: idPrefix,
        surfaceFamily,
        surface,
        storyId: idPrefix,
        viewport,
        deviceScaleFactor: 1,
        screenshot: '',
        scopes: railDiscovery.map((scope) => scope.capturedScope),
      },
    ],
  };
  const aggregatedRowFamilies =
    collectAggregatedGeometryRowFamilies(localCapture).get(surfaceFamily) ?? new Set<string>();
  const cards: Array<{ detail: ReportDetail; magnitude: number }> = [];
  const collected = [
    ...railDiscovery.flatMap((scope, scopeIndex): readonly ReportDetail[] => {
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

      return Array.from(railRegions.entries()).flatMap(([region, rails]): ReportDetail[] => {
        const groupedScope = { ...scope, rails };
        const outlierGroups = groupDiscoveryOutliers(groupedScope);
        return outlierGroups.map(
          ({ label, measurement, representative, line }, outlierIndex): ReportDetail => {
            const id = `discovery-${idPrefix}-${scopeIndex + 1}-${region}-${outlierIndex + 1}`;
            const stableLocator = representative.locator ?? {
              role: 'unknown',
              name: representative.label ?? label,
            };
            const sectionScope = (representative as Partial<GeometryCapturedCandidate>)
              .sectionScope;
            const findingKey = alignmentFindingKey({
              surfaceFamily,
              locator: geometryIdentityLocator(stableLocator, {
                aggregatedRowFamilies,
                ...(sectionScope ? { section: sectionScope } : {}),
              }),
              anchor: representative.anchor,
              axis: 'x',
            });
            return {
              kind: 'candidate',
              requiresReview: true,
              findingKey,
              id,
              title: `${discoverySurfaceLabel(surface)} · ${discoveryScopeLabel(scope)} · ${regionLabels[region]}`,
              description: `${label} · ${DISCOVERY_ANCHOR_LABELS[representative.anchor]} · 1 条 evidence`,
              finding: `候选 · ${label} ${measurement}`,
              clip: clampClip(
                {
                  x: scope.rect.x - 8,
                  y: scope.rect.y - 12,
                  width: scope.rect.width + 416,
                  height: scope.rect.height + 24,
                },
                viewport
              ),
              images: reportImages(id),
              overlay: {
                alignmentGroups: [],
                baselineGroups: [],
                hoverActions: false,
                semanticAnnotations: [
                  {
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
                  },
                ],
                discoveredRails: rails
                  .filter((rail) => Math.abs(rail.line - line) < 0.01)
                  .map((rail) => ({
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
          }
        );
      });
    }),
  ];
  // Every group is measured; only the worst are photographed. A card costs two
  // screenshots, and the finding cards below still cover the rest from the
  // capture's overview image.
  cards.push(
    ...collected.map((detail) => ({
      detail,
      magnitude: Math.abs(detail.overlay.semanticAnnotations[0]?.offset ?? 0),
    }))
  );
  return cards
    .sort(
      (left, right) =>
        right.magnitude - left.magnitude || left.detail.id.localeCompare(right.detail.id)
    )
    .slice(0, MAX_DISCOVERY_CARDS_PER_SURFACE)
    .map(({ detail }) => detail);
}

/**
 * Y cards, built from the FINISHED findings artifact rather than from a second
 * local pipeline. That is the whole point: a card that recomputes its own rails
 * prints one number while the finding it belongs to prints another, and a
 * reviewer cannot tell which one is the measurement. Here every annotation is
 * the finding's own evidence for the capture the card was shot on.
 *
 * The clip holds the WHOLE row plus a margin above and below, because a median
 * guide you cannot see both sides of is not evidence of anything.
 */
const Y_CARD_MARGIN = 24;

/**
 * The report has a screenshot budget, and it is spent on what a reviewer reads:
 * one overview per capture, the worst Y findings across every surface, and the
 * worst X discovery groups per surface. `scripts/generate-…` fails the run if
 * the assets directory outgrows `MAX_REPORT_SCREENSHOTS`.
 */
const MAX_Y_FINDING_CARDS = 12;
const MAX_DISCOVERY_CARDS_PER_SURFACE = 6;

function createFindingBlockDetail({
  finding,
  evidence,
  index,
  viewport,
}: Readonly<{
  finding: GeometryFinding;
  evidence: GeometryFindingEvidence;
  index: number;
  viewport: Readonly<{ width: number; height: number }>;
}>): ReportDetail {
  const members = evidence.rowMembers ?? [];
  const rowStart = Math.min(...members.map((member) => member.xStart), evidence.xStart ?? 0);
  const rowEnd = Math.max(...members.map((member) => member.xEnd), evidence.xEnd ?? 0);
  const rowTop = Math.min(...members.map((member) => member.yStart), evidence.yStart);
  const rowBottom = Math.max(...members.map((member) => member.yEnd), evidence.yEnd);
  // The gutter stacks one label per member, so the band has to be tall enough
  // to hold them all as well as the row: a clipped label is unreadable.
  const bandHeight = Math.max(rowBottom - rowTop + Y_CARD_MARGIN * 2, members.length * 26 + 26, 72);
  const anchorLabel =
    DISCOVERY_ANCHOR_LABELS[finding.anchor as keyof typeof DISCOVERY_ANCHOR_LABELS] ??
    finding.anchor;
  const rowLabel = members.map((member) => member.label).join(' · ') || finding.label;
  const isSpread = finding.kind === 'row-spread';
  const measurementOf = (member: GeometryRowMember) =>
    isSpread
      ? `${anchorLabel} 行内跨度 ${Number(Math.abs(evidence.offset).toFixed(2))}px`
      : `${anchorLabel} ${formatDirectionalOffset('y', member.offset)}`;
  return {
    kind: 'candidate',
    requiresReview: true,
    findingKey: finding.key,
    id: `block-${index + 1}`,
    title: `${finding.surfaceFamily} · 行内垂直对齐 · ${rowLabel}`,
    description: `${finding.label} · ${anchorLabel} · 行内 ${members.length} 个元素`,
    finding: `${isSpread ? '行内跨度' : '候选'} · ${finding.label} ${anchorLabel} ${
      isSpread
        ? `${Number(Math.abs(evidence.offset).toFixed(2))}px`
        : formatDirectionalOffset('y', evidence.offset)
    } · 行中位线 ${Number(evidence.line.toFixed(2))}px`,
    clip: clampClip(
      {
        x: rowStart - 12,
        y: (rowTop + rowBottom) / 2 - bandHeight / 2,
        width: rowEnd - rowStart + 420,
        height: bandHeight,
      },
      viewport
    ),
    images: reportImages(`block-${index + 1}`),
    overlay: {
      alignmentGroups: [],
      baselineGroups: [],
      hoverActions: false,
      // Only the verdict anchor is drawn. A supporting anchor on the same card
      // would put a second number beside a member and make the card say two
      // things about one element.
      semanticAnnotations: members.map((member) => ({
        label: member.label,
        measurement: measurementOf(member),
        layout: 'gutter-list' as const,
        tone: 'candidate' as const,
        axis: 'y' as const,
        coordinate: member.coordinate,
        line: evidence.line,
        offset: member.offset,
        rect: {
          x: member.xStart,
          y: member.yStart,
          width: Math.max(1, member.xEnd - member.xStart),
          height: Math.max(1, member.yEnd - member.yStart),
        },
      })),
      discoveredRails: [],
      blockGuides: [
        {
          line: evidence.line,
          xStart: rowStart,
          xEnd: rowEnd,
          members: members.map((member) => ({
            coordinate: member.coordinate,
            xStart: member.xStart,
            xEnd: member.xEnd,
            outlier: member.outlier,
          })),
        },
      ],
    },
  };
}

/**
 * The largest-|offset| Y findings across EVERY surface, one card each. Each is
 * shot on the capture whose evidence the card prints, so the annotated number,
 * the median guide and the finding are one measurement.
 */
function selectYFindingCards(
  findings: readonly GeometryFinding[],
  limit: number,
  /** Captures already open in a warm context; a cold one costs a bundle parse. */
  preferredCaptureIds: ReadonlySet<string>
): readonly Readonly<{
  finding: GeometryFinding;
  evidence: GeometryFindingEvidence;
}>[] {
  return findings
    .filter((finding) => finding.axis === 'y' && finding.kind !== 'measurement-model-divergence')
    .flatMap((finding) => {
      // The capture whose evidence is closest to the merged offset, so the card
      // is representative rather than the worst outlier of a merged group; ties
      // go to a capture the warm context can already show.
      const evidence = [...finding.evidence].sort(
        (left, right) =>
          Math.abs(left.offset - finding.offset) - Math.abs(right.offset - finding.offset) ||
          Number(preferredCaptureIds.has(right.captureId)) -
            Number(preferredCaptureIds.has(left.captureId)) ||
          left.captureId.localeCompare(right.captureId)
      )[0];
      return evidence && (evidence.rowMembers?.length ?? 0) > 0 ? [{ finding, evidence }] : [];
    })
    .sort(
      (left, right) =>
        Math.abs(right.finding.offset) - Math.abs(left.finding.offset) ||
        left.finding.key.localeCompare(right.finding.key)
    )
    .slice(0, limit);
}

function createDiscoveryOverviewDetail({
  surface,
  idPrefix,
  viewport,
  railDiscovery,
  clip = { x: 0, y: 0, width: viewport.width, height: viewport.height },
}: Readonly<{
  surface: string;
  idPrefix: string;
  viewport: Readonly<{ width: number; height: number }>;
  railDiscovery: readonly BrowserAlignmentRailDiscoveryScope[];
  clip?: GeometryRect;
}>): ReportDetail {
  const railsByPosition = new Map<
    string,
    {
      line: number;
      members: Array<{
        coordinate: number;
        yStart: number;
        yEnd: number;
        outlier: boolean;
      }>;
    }
  >();
  const outlierElements = new Set<string>();
  for (const scope of railDiscovery) {
    for (const rail of scope.rails) {
      const key = `${rail.anchor}:${rail.space ?? 'ink'}:${rail.line.toFixed(1)}`;
      const existing = railsByPosition.get(key) ?? { line: rail.line, members: [] };
      const memberKeys = new Set(
        existing.members.map(
          (member) =>
            `${member.coordinate.toFixed(2)}:${member.yStart.toFixed(2)}:${member.yEnd.toFixed(2)}`
        )
      );
      for (const member of rail.members) {
        const memberKey = `${member.coordinate.toFixed(2)}:${member.yStart.toFixed(2)}:${member.yEnd.toFixed(2)}`;
        if (!memberKeys.has(memberKey)) {
          existing.members.push({
            coordinate: member.coordinate,
            yStart: member.yStart,
            yEnd: member.yEnd,
            outlier: member.outlier,
          });
          memberKeys.add(memberKey);
        }
        if (member.outlier) outlierElements.add(`${member.rowId}:${member.elementId}`);
      }
      railsByPosition.set(key, existing);
    }
  }
  const discoveredRails = Array.from(railsByPosition.values());
  const id = `overview-${idPrefix}`;
  return {
    kind: 'overview',
    requiresReview: false,
    id,
    title: `${discoverySurfaceLabel(surface)} · 整体视图`,
    description: '完整页面构图；局部卡片继续说明具体候选轨与偏移元素',
    finding:
      discoveredRails.length > 0
        ? `整体 · ${discoveredRails.length} 条候选轨 · ${outlierElements.size} 个待确认元素`
        : '整体 · 当前状态没有足够重复证据形成候选轨',
    clip: clampClip(clip, viewport),
    images: reportImages(id),
    overlay: {
      alignmentGroups: [],
      baselineGroups: [],
      hoverActions: false,
      semanticAnnotations: [],
      discoveredRails,
    },
  };
}

async function waitForSessionConversationStory(page: Page): Promise<void> {
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

async function enableReportCaptureMode(page: Page): Promise<void> {
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

type GeometryReplayCapture = Readonly<{
  storyId: string;
  storyGlobals?: string;
  viewport: Readonly<{ width: number; height: number }>;
  deviceScaleFactor: number;
  dimensions?: Readonly<{ theme?: string }>;
}>;

/**
 * A context is only worth opening once per SCALE and THEME. Device scale and
 * colour scheme are fixed when a context is created, but a viewport is not, and
 * a fresh context starts with a cold HTTP cache — so one context per capture
 * re-downloads and re-parses the whole Storybook bundle every time, which is
 * minutes of wall clock and the reason a story can miss its readiness deadline.
 */
function geometryReplayContextKey(capture: GeometryReplayCapture): string {
  return `${capture.deviceScaleFactor}|${capture.dimensions?.theme === 'dark' ? 'dark' : 'light'}`;
}

async function openGeometryReplayContext(
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
    if (url.origin === storybookOrigin) {
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
 * the same way the original pass settled it. Shared by the `--after` replay and
 * by the Y cards, so a card and a repair image are never shot against a
 * differently composed page.
 */
async function showGeometryCaptureStory(
  context: BrowserContext,
  capture: GeometryReplayCapture
): Promise<Page> {
  // A fresh PAGE per capture, inside the shared context: the context keeps the
  // HTTP cache warm, and a page that has loaded a dozen stories in a row runs
  // its renderer out of memory and crashes mid-navigation.
  const page = await context.newPage();
  await page.setViewportSize(capture.viewport);
  const response = await page.goto(
    `${storybookOrigin}/iframe.html?id=${capture.storyId}&viewMode=story${
      capture.storyGlobals ? `&globals=${capture.storyGlobals}` : ''
    }`
  );
  if (!response?.ok()) throw new Error(`Story capture failed: ${capture.storyId}`);
  if (capture.storyId.includes('sessionconversationpage')) {
    await waitForSessionConversationStory(page);
  }
  await enableReportCaptureMode(page);
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

async function captureAfterReport(browser: Browser, reportOutputDirectory: string): Promise<void> {
  const dataPath = path.join(reportOutputDirectory, 'report-data.json');
  const reportData = JSON.parse(await readFile(dataPath, 'utf8')) as PersistedReportData;
  const capturesById = new Map(
    reportData.coverage.captures.map((capture) => [capture.captureId, capture])
  );
  const detailsByCapture = new Map<string, PersistedReportData['details']>();
  for (const detail of reportData.details) {
    if (!detail.captureId) {
      throw new Error(`Geometry detail ${detail.id} has no replayable captureId`);
    }
    const captureDetails = detailsByCapture.get(detail.captureId) ?? [];
    captureDetails.push(detail);
    detailsByCapture.set(detail.captureId, captureDetails);
  }
  if (detailsByCapture.size === 0) return;

  const unexpectedNetworkRequests: string[] = [];
  const replayGroups = new Map<string, string[]>();
  for (const captureId of detailsByCapture.keys()) {
    const capture = capturesById.get(captureId);
    if (!capture) throw new Error(`Geometry capture ${captureId} is missing from coverage`);
    const key = geometryReplayContextKey(capture);
    replayGroups.set(key, [...(replayGroups.get(key) ?? []), captureId]);
  }
  for (const captureIds of replayGroups.values()) {
    const first = capturesById.get(captureIds[0] ?? '');
    if (!first) continue;
    const context = await openGeometryReplayContext(browser, first, unexpectedNetworkRequests);
    for (const captureId of captureIds) {
      const capture = capturesById.get(captureId);
      if (!capture) continue;
      const page = await showGeometryCaptureStory(context, capture);
      for (const detail of detailsByCapture.get(captureId) ?? []) {
        const after = `assets/detail-${detail.id}-after.png`;
        await page.screenshot({
          path: path.join(reportOutputDirectory, after),
          clip: detail.clip,
          animations: 'disabled',
          caret: 'hide',
          scale: 'device',
        });
        detail.images.after = after;
      }
      await page.close();
    }
    await context.close();
  }

  reportData.afterCapturedAt = new Date().toISOString();
  await writeFile(dataPath, `${JSON.stringify(reportData, null, 2)}\n`, 'utf8');
  if (unexpectedNetworkRequests.length > 0) {
    throw new Error(`Unexpected network requests: ${unexpectedNetworkRequests.join(', ')}`);
  }
}

test.skip(!outputDirectory, 'Run through the geometry:report script');

test('captures the visual geometry report', async ({ browser }) => {
  test.setTimeout(2_400_000);
  if (!outputDirectory) throw new Error('GEOMETRY_REPORT_OUTPUT_DIR is required');
  if (reportPhase === 'after') {
    await captureAfterReport(browser, outputDirectory);
    return;
  }

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
  const geometryObservationCache: GeometryObservationCache = new Map();
  const cleanUrl = `${storybookOrigin}/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story`;
  const cleanResponse = await page.goto(cleanUrl);
  if (!cleanResponse?.ok()) throw new Error(`Story capture failed: ${cleanUrl}`);
  await enableReportCaptureMode(page);
  const hoverActions = page.locator('[data-geometry-hover-action]');
  await hoverActions.count();

  const measurement = await measureSettledChatWorkspace(page);
  const geometryViolations = validateChatWorkspaceGeometry(measurement.snapshot, {
    sidebar: 'expanded',
    spacingMeasurements: measurement.spacingMeasurements,
  });

  const spacingAudit = await auditChatWorkspaceSpacing(page);
  const semanticAlignments = await auditChatWorkspaceSemanticAlignments(page);
  const semanticBaselines = await auditChatWorkspaceSemanticBaselines(page);
  const railDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
    aggregateScopes: ['sidebar.shell'],
    captureId: 'workspace:wide-expanded',
    surfaceFamily: 'workspace',
    observationCache: geometryObservationCache,
  });
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
  const workspaceOverview = createDiscoveryOverviewDetail({
    surface: 'Workspace / Chat Landing',
    idPrefix: 'workspace-wide-expanded',
    viewport,
    railDiscovery,
  });
  const workspaceDetails: ReportDetail[] = [
    workspaceOverview,
    ...semanticDetails,
    ...workspaceDiscoveryDetails,
  ];
  const detailCaptureIds = new Map<string, string>();
  const assignDetailsToCapture = (details: readonly ReportDetail[], captureId: string) => {
    for (const detail of details) {
      const existingCaptureId = detailCaptureIds.get(detail.id);
      if (existingCaptureId && existingCaptureId !== captureId) {
        throw new Error(
          `Geometry detail ${detail.id} belongs to both ${existingCaptureId} and ${captureId}`
        );
      }
      detailCaptureIds.set(detail.id, captureId);
    }
  };
  assignDetailsToCapture(workspaceDetails, 'workspace:wide-expanded');

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
  if (!annotatedResponse?.ok()) throw new Error(`Story capture failed: ${annotatedUrl}`);
  await enableReportCaptureMode(page);
  await measureSettledChatWorkspace(page);
  const spacingOverlay = page.locator('[data-geometry-devtool="spacing-audit"]');
  await spacingOverlay.waitFor({ state: 'attached' });
  const semanticOverlay = page.locator('[data-geometry-devtool="semantic-baselines"]');
  await semanticOverlay.waitFor({ state: 'attached' });
  const alignmentOverlay = page.locator('[data-geometry-devtool="semantic-alignments"]');
  await alignmentOverlay.waitFor({ state: 'attached' });
  await page.locator('[data-geometry-devtool="reference-grid"]').waitFor({ state: 'visible' });
  await page.locator('[data-geometry-grid-scope="sidebar"]').waitFor({ state: 'visible' });
  const visibleProductionRows = page.locator('[data-sidebar-session-id]:visible');
  await spacingOverlay.evaluate((element) => {
    (element as HTMLElement).style.display = 'none';
  });
  await page.locator('[data-geometry-devtool="reference-grid"]').evaluate((element) => {
    (element as HTMLElement).style.display = 'none';
  });
  for (const detail of workspaceDetails) {
    await showOnlyDetailSemanticGuides(page, detail);
    await page.locator('[data-geometry-report-member-label]').count();
    await visibleProductionRows.count();
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
      contractDomain: 'workspace' | 'session' | 'right-sidebar';
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
  const coverageCaptures: Array<
    Readonly<{
      captureId: string;
      area: 'workspace' | 'session' | 'right-sidebar';
      surface: string;
      storyId: string;
      storyGlobals?: string;
      viewport: Readonly<{ width: number; height: number }>;
      deviceScaleFactor: number;
      dimensions: GeometryCaptureDimensions;
    }>
  > = [
    {
      captureId: 'workspace:wide-expanded',
      area: 'workspace',
      surface: 'Workspace / Chat Landing',
      storyId: 'geometry-chatworkspace--expanded-sidebar',
      viewport,
      deviceScaleFactor: 2,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
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
    if (!response?.ok()) throw new Error(`Story capture failed: ${storyId}`);
    await enableReportCaptureMode(matrixPage);
    await measureSettledChatWorkspace(matrixPage);
    const matrixDiscovery = await discoverChatWorkspaceAlignmentRails(matrixPage, {
      aggregateScopes: ['sidebar.shell'],
      captureId: `workspace:${verificationCase.name}`,
      surfaceFamily: 'workspace',
      observationCache: geometryObservationCache,
    });
    const matrixOverview = createDiscoveryOverviewDetail({
      surface: `Workspace / ${verificationCase.name}`,
      idPrefix: `workspace-${verificationCase.name}`,
      viewport: verificationCase.viewport,
      railDiscovery: matrixDiscovery,
    });
    assignDetailsToCapture([matrixOverview], `workspace:${verificationCase.name}`);
    await matrixPage.screenshot({
      path: path.join(outputDirectory, matrixOverview.images.clean),
      clip: matrixOverview.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
    await showOnlyDetailSemanticGuides(matrixPage, matrixOverview);
    await matrixPage.screenshot({
      path: path.join(outputDirectory, matrixOverview.images.annotated),
      clip: matrixOverview.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
    workspaceDetails.push(matrixOverview);
    discoverySurfaces.push({
      captureId: `workspace:${verificationCase.name}`,
      contractDomain: 'workspace',
      surface: `Workspace / ${verificationCase.name}`,
      viewport: verificationCase.viewport,
      railDiscovery: matrixDiscovery,
    });
    coverageCaptures.push({
      captureId: `workspace:${verificationCase.name}`,
      area: 'workspace',
      surface: `Workspace / ${verificationCase.name}`,
      storyId,
      viewport: verificationCase.viewport,
      deviceScaleFactor: 1,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    });
    await matrixContext.close();
  }

  for (const dimension of WORKSPACE_DIMENSION_CAPTURES) {
    const dimensionContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
      colorScheme: dimension.colorScheme,
    });
    await dimensionContext.route(/https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === storybookOrigin) {
        await route.continue();
        return;
      }
      unexpectedNetworkRequests.push(url.href);
      await route.abort('blockedbyclient');
    });
    const dimensionPage = await dimensionContext.newPage();
    const dimensionStoryId = 'geometry-chatworkspace--expanded-sidebar';
    const dimensionUrl = `${storybookOrigin}/iframe.html?id=${dimensionStoryId}&viewMode=story&globals=${dimension.globals}`;
    const dimensionResponse = await dimensionPage.goto(dimensionUrl);
    if (!dimensionResponse?.ok()) throw new Error(`Story capture failed: ${dimensionUrl}`);
    await enableReportCaptureMode(dimensionPage);
    await measureSettledChatWorkspace(dimensionPage);
    const expectedText = 'expectedText' in dimension ? dimension.expectedText : undefined;
    if (expectedText) {
      await dimensionPage
        .getByText(expectedText, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
    }
    if (dimension.dimensions.theme === 'dark') {
      const isDark = await dimensionPage.evaluate(() =>
        document.documentElement.classList.contains('dark')
      );
      if (!isDark) throw new Error(`${dimension.id} did not apply the dark theme global`);
    }
    const dimensionCaptureId = `workspace:${dimension.id}`;
    const dimensionDiscovery = await discoverChatWorkspaceAlignmentRails(dimensionPage, {
      aggregateScopes: ['sidebar.shell'],
      captureId: dimensionCaptureId,
      surfaceFamily: 'workspace',
      observationCache: geometryObservationCache,
    });
    const dimensionOverview = createDiscoveryOverviewDetail({
      surface: dimension.surface,
      idPrefix: dimension.id,
      viewport,
      railDiscovery: dimensionDiscovery,
    });
    assignDetailsToCapture([dimensionOverview], dimensionCaptureId);
    await dimensionPage.screenshot({
      path: path.join(outputDirectory, dimensionOverview.images.clean),
      clip: dimensionOverview.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
    await showOnlyDetailSemanticGuides(dimensionPage, dimensionOverview);
    await dimensionPage.screenshot({
      path: path.join(outputDirectory, dimensionOverview.images.annotated),
      clip: dimensionOverview.clip,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
    workspaceDetails.push(dimensionOverview);
    discoverySurfaces.push({
      captureId: dimensionCaptureId,
      contractDomain: 'workspace',
      surface: dimension.surface,
      viewport,
      railDiscovery: dimensionDiscovery,
    });
    coverageCaptures.push({
      captureId: dimensionCaptureId,
      area: 'workspace',
      surface: dimension.surface,
      storyId: dimensionStoryId,
      storyGlobals: dimension.globals,
      viewport,
      deviceScaleFactor: 2,
      dimensions: dimension.dimensions,
    });
    await dimensionContext.close();
  }

  for (const story of WORKSPACE_STATE_CAPTURES) {
    const response = await page.goto(
      `${storybookOrigin}/iframe.html?id=${story.storyId}&viewMode=story`
    );
    if (!response?.ok()) throw new Error(`Story capture failed: ${story.storyId}`);
    await enableReportCaptureMode(page);
    const stateMeasurement = await measureSettledChatWorkspace(page);
    const stateRailDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
      aggregateScopes: ['sidebar.shell'],
      captureId: `workspace:${story.id}:1440x900`,
      surfaceFamily: 'workspace',
      observationCache: geometryObservationCache,
    });
    const stateMainPane = requireGeometryRect(
      stateMeasurement.snapshot,
      CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane
    );
    const mainDiscovery = stateRailDiscovery.filter(
      (scope) => scope.scope === 'main.chat-landing' || scope.rect.x >= stateMainPane.x - 1
    );
    const discoveredStateDetails = createDiscoveryDetails({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: mainDiscovery,
    });
    const stateOverview = createDiscoveryOverviewDetail({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: stateRailDiscovery,
    });
    const stateDetails = [stateOverview, ...discoveredStateDetails];
    const captureId = `workspace:${story.id}:1440x900`;
    assignDetailsToCapture(stateDetails, captureId);
    for (const detail of stateDetails) {
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.clean),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    for (const detail of stateDetails) {
      await showOnlyDetailSemanticGuides(page, detail);
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.annotated),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    workspaceDetails.push(...stateDetails);
    discoverySurfaces.push({
      captureId,
      contractDomain: 'workspace',
      surface: story.surface,
      viewport,
      railDiscovery: stateRailDiscovery,
    });
    coverageCaptures.push({
      captureId,
      area: 'workspace',
      surface: story.surface,
      storyId: story.storyId,
      viewport,
      deviceScaleFactor: 2,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    });
  }

  const sessionDetails: ReportDetail[] = [];

  for (const story of SESSION_STATE_CAPTURES) {
    const response = await page.goto(
      `${storybookOrigin}/iframe.html?id=${story.storyId}&viewMode=story`
    );
    if (!response?.ok()) throw new Error(`Story capture failed: ${story.storyId}`);
    await waitForSessionConversationStory(page);
    await enableReportCaptureMode(page);
    if (story.id === 'session-working') {
      await page.locator('[data-stream-phase="indicator-only"]').waitFor({ state: 'attached' });
    }
    if (story.id === 'session-permission') {
      const responseActionBar = page.locator(
        '[data-geometry-capture-reveal="true"]:has(.lucide-info)'
      );
      await responseActionBar.first().waitFor({ state: 'attached' });
    }
    const sessionRailDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
      aggregateScopes: ['session.page'],
      captureId: `${story.id}:1440x900`,
      surfaceFamily: 'session',
      observationCache: geometryObservationCache,
    });
    const storyDetails = createDiscoveryDetails({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: sessionRailDiscovery,
    });
    const sessionOverview = createDiscoveryOverviewDetail({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: sessionRailDiscovery,
    });
    const sessionReportDetails = [sessionOverview, ...storyDetails];
    const captureId = `${story.id}:1440x900`;
    assignDetailsToCapture(sessionReportDetails, captureId);

    for (const detail of sessionReportDetails) {
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.clean),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    for (const detail of sessionReportDetails) {
      await showOnlyDetailSemanticGuides(page, detail);
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.annotated),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }

    sessionDetails.push(...sessionReportDetails);
    discoverySurfaces.push({
      captureId,
      contractDomain: 'session',
      surface: story.surface,
      viewport,
      railDiscovery: sessionRailDiscovery,
    });
    coverageCaptures.push({
      captureId,
      area: 'session',
      surface: story.surface,
      storyId: story.storyId,
      viewport,
      deviceScaleFactor: 2,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
    });
  }

  for (const story of RIGHT_SIDEBAR_STATE_CAPTURES) {
    const response = await page.goto(
      `${storybookOrigin}/iframe.html?id=${story.storyId}&viewMode=story`
    );
    if (!response?.ok()) throw new Error(`Story capture failed: ${story.storyId}`);
    await enableReportCaptureMode(page);
    const rightSidebarRailDiscovery = await discoverChatWorkspaceAlignmentRails(page, {
      aggregateScopes: ['session.side-panel'],
      captureId: `${story.id}:1440x900`,
      surfaceFamily: 'right-sidebar',
      observationCache: geometryObservationCache,
    });
    const discoveredRightSidebarDetails = createDiscoveryDetails({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: rightSidebarRailDiscovery,
    });
    const sidePanelScope = rightSidebarRailDiscovery.find(
      (scope) => scope.scope === 'session.side-panel'
    );
    if (!sidePanelScope) throw new Error(`${story.storyId} did not expose session.side-panel`);
    const rightSidebarOverview = createDiscoveryOverviewDetail({
      surface: story.surface,
      idPrefix: story.id,
      viewport,
      railDiscovery: rightSidebarRailDiscovery,
      clip: {
        x: sidePanelScope.rect.x - 8,
        y: sidePanelScope.rect.y - 8,
        width: sidePanelScope.rect.width + 16,
        height: sidePanelScope.rect.height + 16,
      },
    });
    const rightSidebarDetails = [rightSidebarOverview, ...discoveredRightSidebarDetails];
    const captureId = `${story.id}:1440x900`;
    assignDetailsToCapture(rightSidebarDetails, captureId);
    for (const detail of rightSidebarDetails) {
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.clean),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    for (const detail of rightSidebarDetails) {
      await showOnlyDetailSemanticGuides(page, detail);
      await page.screenshot({
        path: path.join(outputDirectory, detail.images.annotated),
        clip: detail.clip,
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
      });
    }
    sessionDetails.push(...rightSidebarDetails);
    discoverySurfaces.push({
      captureId,
      contractDomain: 'right-sidebar',
      surface: story.surface,
      viewport,
      railDiscovery: rightSidebarRailDiscovery,
    });
    coverageCaptures.push({
      captureId,
      area: 'right-sidebar',
      surface: story.surface,
      storyId: story.storyId,
      viewport,
      deviceScaleFactor: 2,
      dimensions: DEFAULT_CAPTURE_DIMENSIONS,
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
  const scopeKey = (
    contractDomain: 'workspace' | 'session' | 'right-sidebar',
    scope: BrowserAlignmentRailDiscoveryScope
  ) =>
    `${contractDomain}:${
      scope.topology ? `auto:${scope.topology.signature}` : `hint:${scope.scope}`
    }`;
  const contractCaptures = (['workspace', 'session', 'right-sidebar'] as const).flatMap(
    (contractDomain) => {
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
    }
  );
  const contractProposals = inferAlignmentRailContractProposals(contractCaptures, {
    minConfidence: 0.35,
  });

  const detailsByCaptureId = new Map<string, ReportDetail[]>();
  for (const detail of details) {
    const captureId = detailCaptureIds.get(detail.id);
    if (!captureId) continue;
    detailsByCaptureId.set(captureId, [...(detailsByCaptureId.get(captureId) ?? []), detail]);
  }
  const coverageByCaptureId = new Map(
    coverageCaptures.map((capture) => [capture.captureId, capture])
  );
  const captureArtifact: GeometryCaptureArtifact = {
    version: 1,
    captures: discoverySurfaces.map((surface) => {
      const coverage = coverageByCaptureId.get(surface.captureId);
      if (!coverage) throw new Error(`Missing coverage for geometry capture ${surface.captureId}`);
      const representative = detailsByCaptureId
        .get(surface.captureId)
        ?.find((detail) => detail.kind === 'overview');
      const boxModelNodes = Object.assign(
        {},
        ...surface.railDiscovery.map((scope) => scope.capturedScope.boxModelNodes ?? {})
      );
      return {
        captureId: surface.captureId,
        surfaceFamily: surface.contractDomain,
        surface: surface.surface,
        storyId: coverage.storyId,
        viewport: coverage.viewport,
        deviceScaleFactor: coverage.deviceScaleFactor,
        dimensions: coverage.dimensions,
        screenshot: representative?.images.clean ?? '',
        scopes: surface.railDiscovery.map((scope) => {
          const { boxModelNodes: _boxModelNodes, ...capturedScope } = scope.capturedScope;
          return capturedScope;
        }),
        boxModelNodes,
        ...(surface.captureId === 'workspace:wide-expanded'
          ? {
              semanticAlignments: semanticAlignments.map((entry) => {
                const [group, instance] = entry.groupLabel.split(' · ');
                return {
                  group: group ?? entry.groupLabel,
                  instance: instance ?? null,
                  axis: entry.axis,
                  anchor: entry.anchor,
                  status: entry.status,
                  line: entry.line,
                  members: entry.members.map((member) => ({
                    name: member.name,
                    coordinate: member.coordinate,
                    ...(member.primitiveId ? { primitiveId: member.primitiveId } : {}),
                    rect: member.rect,
                  })),
                };
              }),
              // The baseline rules travel with the alignment rules so
              // marker-removal readiness asks one question of every marker.
              semanticBaselines: semanticBaselines.map((entry) => {
                const [group, instance] = entry.groupLabel.split(' · ');
                return {
                  group: group ?? entry.groupLabel,
                  instance: instance ?? null,
                  axis: 'y' as const,
                  anchor: 'text-baseline' as const,
                  status: entry.status,
                  line: entry.line,
                  members: entry.members.map((member) => ({
                    name: member.name,
                    coordinate: member.coordinate,
                    ...(member.primitiveId ? { primitiveId: member.primitiveId } : {}),
                    rect: member.rect,
                  })),
                };
              }),
            }
          : {}),
      };
    }),
  };
  const capturePath = path.join(outputDirectory, 'capture.json');
  const observationPath = path.join(outputDirectory, 'observation.json');
  const findingsPath = path.join(outputDirectory, 'findings.json');
  const contractsPath = path.join(outputDirectory, 'contracts.json');
  await writeFile(capturePath, `${JSON.stringify(captureArtifact, null, 2)}\n`, 'utf8');

  const persistedCapture = JSON.parse(
    await readFile(capturePath, 'utf8')
  ) as GeometryCaptureArtifact;
  const observationArtifact = observeGeometryCaptures(persistedCapture);
  await writeFile(observationPath, `${JSON.stringify(observationArtifact, null, 2)}\n`, 'utf8');

  const persistedObservation = JSON.parse(await readFile(observationPath, 'utf8')) as ReturnType<
    typeof observeGeometryCaptures
  >;
  const findingArtifact = createGeometryFindings(persistedCapture, persistedObservation);
  await writeFile(findingsPath, `${JSON.stringify(findingArtifact, null, 2)}\n`, 'utf8');

  // Parity, not a second measurement model: the marker rule and marker-free Y
  // discovery are asked about the same capture, matched by ELEMENT, and every
  // member only one of them saw is listed instead of being averaged away.
  const wideExpandedCapture = persistedCapture.captures.find(
    (capture) => capture.captureId === 'workspace:wide-expanded'
  );
  if (!wideExpandedCapture) throw new Error('Geometry report lost the wide-expanded capture');
  const yAxisParity = compareMarkerAlignmentsToBlockRails(
    wideExpandedCapture,
    persistedObservation.captures.find((capture) => capture.captureId === 'workspace:wide-expanded')
      ?.blockRails ?? [],
    { group: 'sidebar.row.visual-center' }
  );
  await writeFile(
    path.join(outputDirectory, 'y-axis-parity.json'),
    `${JSON.stringify(yAxisParity, null, 2)}\n`,
    'utf8'
  );

  // Can each marker rule be deleted yet? A marker is business-code weight, so
  // the artifact answers per RULE and per member, on every capture the rule
  // appears in: one capture where discovery cannot see a member is one
  // regression removing the marker would hide.
  const markerRemoval = assessGeometryMarkerRemoval(persistedCapture, persistedObservation);
  await writeFile(
    path.join(outputDirectory, 'marker-removal-readiness.json'),
    `${JSON.stringify(markerRemoval, null, 2)}\n`,
    'utf8'
  );

  const persistedFindings = JSON.parse(
    await readFile(findingsPath, 'utf8')
  ) as GeometryFindingArtifact;
  const ledger = JSON.parse(
    await readFile(new URL('../../geometry-ledger.json', import.meta.url), 'utf8')
  ) as GeometryLedger;
  const findingDiff = diffGeometryFindings(persistedFindings, ledger);
  // Triage applies these moves; it never re-derives them. The re-key decision
  // stays in one place, beside the identity rules that caused the re-key.
  await writeFile(
    path.join(outputDirectory, 'finding-diff.json'),
    `${JSON.stringify(
      {
        version: 1,
        new: findingDiff.new.map((finding) => finding.key),
        changed: findingDiff.changed.map((finding) => finding.key),
        resolved: findingDiff.resolved,
        rekeyed: findingDiff.rekeyed,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  // Zoomed Y cards for the largest-|offset| findings across EVERY surface, shot
  // in a second pass because they are drawn from the finished findings: a card
  // built during the capture walk could only guess at the merged measurement.
  // The main context is already warm at this point, so a Y card shot at its
  // scale and theme reuses it instead of paying a cold bundle parse again.
  const mainContextKey = geometryReplayContextKey({
    storyId: '',
    viewport,
    deviceScaleFactor: 2,
    dimensions: DEFAULT_CAPTURE_DIMENSIONS,
  });
  const warmCaptureIds = new Set(
    coverageCaptures
      .filter((capture) => geometryReplayContextKey(capture) === mainContextKey)
      .map((capture) => capture.captureId)
  );
  const yCards = selectYFindingCards(
    persistedFindings.findings,
    MAX_Y_FINDING_CARDS,
    warmCaptureIds
  );
  const yCardDetails: ReportDetail[] = [];
  const yCardsByCapture = new Map<string, Array<{ detail: ReportDetail; index: number }>>();
  for (const [index, { finding, evidence }] of yCards.entries()) {
    const capture = coverageByCaptureId.get(evidence.captureId);
    if (!capture) continue;
    const detail = createFindingBlockDetail({
      finding,
      evidence,
      index,
      viewport: capture.viewport,
    });
    // The addendum's check, made executable: an annotation on a Y card is the
    // finding's own evidence for that member, or the card is a second opinion
    // dressed as a measurement.
    const rowMembers = evidence.rowMembers ?? [];
    // Matched by POSITION, not by label: two members of one row can carry the
    // same accessible name, and a card that annotated the wrong one would be
    // exactly the mismatch this check exists to catch.
    if (detail.overlay.semanticAnnotations.length !== rowMembers.length) {
      throw new Error(`Geometry Y card ${detail.id} annotates a different row than it measured`);
    }
    for (const [memberIndex, annotation] of detail.overlay.semanticAnnotations.entries()) {
      const member = rowMembers[memberIndex];
      if (!member || Math.abs(member.offset - annotation.offset) > 1e-9) {
        throw new Error(
          `Geometry Y card ${detail.id} annotates ${annotation.label} with an offset the finding does not report`
        );
      }
    }
    if (
      finding.kind !== 'row-spread' &&
      !rowMembers.some((member) => Math.abs(member.offset - evidence.offset) < 1e-9)
    ) {
      throw new Error(`Geometry Y card ${detail.id} lost the member the finding is about`);
    }
    yCardDetails.push(detail);
    detailCaptureIds.set(detail.id, evidence.captureId);
    yCardsByCapture.set(evidence.captureId, [
      ...(yCardsByCapture.get(evidence.captureId) ?? []),
      { detail, index },
    ]);
  }
  const yCardGroups = new Map<string, string[]>();
  for (const captureId of yCardsByCapture.keys()) {
    const capture = coverageByCaptureId.get(captureId);
    if (!capture) continue;
    const key = geometryReplayContextKey(capture);
    yCardGroups.set(key, [...(yCardGroups.get(key) ?? []), captureId]);
  }
  // A zoomed card is EXTRA evidence: the finding already has a card built on
  // its capture's overview image. So a capture whose story cannot be reopened
  // costs the zoom, not the report — recorded by id rather than swallowed.
  const skippedYCards: string[] = [];
  for (const [groupKey, captureIds] of yCardGroups) {
    const first = coverageByCaptureId.get(captureIds[0] ?? '');
    if (!first) continue;
    const reusesMainContext = groupKey === mainContextKey;
    const cardContext = reusesMainContext
      ? context
      : await openGeometryReplayContext(browser, first, unexpectedNetworkRequests);
    for (const captureId of captureIds) {
      const capture = coverageByCaptureId.get(captureId);
      if (!capture) continue;
      const cards = yCardsByCapture.get(captureId) ?? [];
      try {
        const cardPage = await showGeometryCaptureStory(cardContext, capture);
        for (const { detail } of cards) {
          await cardPage.screenshot({
            path: path.join(outputDirectory, detail.images.clean),
            clip: detail.clip,
            animations: 'disabled',
            caret: 'hide',
            scale: 'device',
          });
          await showOnlyDetailSemanticGuides(cardPage, detail);
          await cardPage.screenshot({
            path: path.join(outputDirectory, detail.images.annotated),
            clip: detail.clip,
            animations: 'disabled',
            caret: 'hide',
            scale: 'device',
          });
        }
        await cardPage.close();
      } catch (error) {
        skippedYCards.push(
          `${captureId}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
        );
        for (const { detail } of cards) {
          yCardDetails.splice(yCardDetails.indexOf(detail), 1);
          detailCaptureIds.delete(detail.id);
        }
      }
    }
    if (!reusesMainContext) {
      await cardContext.close().catch(() => undefined);
    }
  }
  const qualityMetrics = computeGeometryQualityMetrics(persistedCapture, ledger);
  const compiledContracts = compileGeometryContracts(ledger);
  await writeFile(contractsPath, `${JSON.stringify(compiledContracts, null, 2)}\n`, 'utf8');
  const pixelWitnesses = await collectGeometryPixelWitnesses(
    page,
    outputDirectory,
    persistedCapture,
    compiledContracts
  );
  const witnessDesignQuestions = pixelWitnesses.flatMap((witness) =>
    witness.inkCenters?.designQuestion ? [witness.inkCenters.designQuestion] : []
  );
  await writeFile(
    path.join(outputDirectory, 'pixel-witnesses.json'),
    `${JSON.stringify(
      {
        version: 1,
        gate: false,
        ...(witnessDesignQuestions.length > 0 ? { designQuestions: witnessDesignQuestions } : {}),
        witnesses: pixelWitnesses,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const rawDetailByFindingKey = new Map(
    [...details, ...yCardDetails].flatMap((detail) =>
      detail.findingKey ? [[detail.findingKey, detail] as const] : []
    )
  );
  const newFindingKeys = new Set(findingDiff.new.map((finding) => finding.key));
  const changedFindingKeys = new Set(findingDiff.changed.map((finding) => finding.key));
  const inkCentersByFindingKey = new Map(
    pixelWitnesses.flatMap((witness) =>
      witness.findingKey && witness.inkCenters
        ? [[witness.findingKey, witness.inkCenters] as const]
        : []
    )
  );
  // The report shows the steady state, not only the delta: every finding in
  // findings.json gets a card, and the ledger status says how it was reviewed.
  const displayedDetails = persistedFindings.findings.flatMap((finding): ReportDetail[] => {
    if (finding.kind === 'measurement-model-divergence') return [];
    const evidence = finding.evidence[0];
    if (!evidence) return [];
    let representative = rawDetailByFindingKey.get(finding.key);
    if (!representative) {
      const overviewEvidence = finding.evidence.flatMap((item) => {
        const overview = detailsByCaptureId
          .get(item.captureId)
          ?.find((detail) => detail.kind === 'overview');
        return overview ? [{ captureId: item.captureId, overview, item }] : [];
      })[0];
      if (!overviewEvidence) return [];
      const { overview } = overviewEvidence;
      const id = `finding-${finding.key.split('/').at(-1) ?? finding.key}`;
      representative = {
        kind: 'candidate',
        requiresReview: finding.classification !== 'optical-residual',
        findingKey: finding.key,
        id,
        title: `${finding.surfaceFamily} · ${finding.label}`,
        description: `${finding.label} · stable locator finding`,
        finding: '',
        clip: overview.clip,
        images: overview.images,
        overlay: {
          alignmentGroups: [],
          baselineGroups: [],
          hoverActions: false,
          semanticAnnotations: [
            {
              label: finding.label,
              axis: finding.axis,
              coordinate: overviewEvidence.item.coordinate,
              line: overviewEvidence.item.line,
              offset: overviewEvidence.item.offset,
              rect:
                finding.axis === 'y'
                  ? {
                      x: overviewEvidence.item.xStart ?? 0,
                      y: overviewEvidence.item.yStart,
                      width: Math.max(
                        1,
                        (overviewEvidence.item.xEnd ?? 0) - (overviewEvidence.item.xStart ?? 0)
                      ),
                      height: Math.max(
                        1,
                        overviewEvidence.item.yEnd - overviewEvidence.item.yStart
                      ),
                    }
                  : {
                      x: overviewEvidence.item.coordinate - 1,
                      y: overviewEvidence.item.yStart,
                      width: 2,
                      height: Math.max(
                        1,
                        overviewEvidence.item.yEnd - overviewEvidence.item.yStart
                      ),
                    },
              tone: 'candidate',
            },
          ],
          discoveredRails: [],
        },
      };
      detailCaptureIds.set(id, overviewEvidence.captureId);
    }
    const direction = formatDirectionalOffset(finding.axis, finding.offset);
    const explanation = evidence.explanation;
    const explainContribution = (
      label: string,
      measuredPath: NonNullable<typeof explanation>['memberPath']
    ) => {
      const terms = Object.entries(measuredPath.contribution)
        .filter(([, value]) => Math.abs(value) >= 0.01)
        .map(([name, value]) => `${name} ${Number(value.toFixed(2))}`)
        .join(' + ');
      return `${label} ${Number(measuredPath.distance.toFixed(2))}px${terms ? ` = ${terms}` : ''}`;
    };
    const boxModelFinding = explanation
      ? ` · 盒模型：${explainContribution('本项', explanation.memberPath)}；${explainContribution(
          '参照',
          explanation.referencePath
        )}；residual ${Number(explanation.residual.toFixed(2))}px`
      : '';
    const classification = finding.classification ?? 'structural';
    const repairProposal = finding.repairProposal
      ? formatRepairProposal(finding.repairProposal)
      : undefined;
    const repairFinding = repairProposal ? ` · ${repairProposal}` : '';
    const dimensionSensitivity = (finding.dimensionSensitivity ?? []).map(
      (item) => `${item.axis}=${item.value}`
    );
    const dimensionFinding =
      dimensionSensitivity.length > 0 ? ` · 仅出现在 ${dimensionSensitivity.join('、')}` : '';
    const ledgerStatus: GeometryLedgerStatus | 'changed' = newFindingKeys.has(finding.key)
      ? 'new'
      : changedFindingKeys.has(finding.key)
        ? 'changed'
        : (ledger.findings[finding.key]?.status ?? 'new');
    const baseline = ledger.findings[finding.key]?.baseline?.offset;
    const inkCenters = inkCentersByFindingKey.get(finding.key);
    const inkCenterWitness = inkCenters
      ? `墨迹中心（非门禁证人，中位数 ${inkCenters.medianInkCenter}px）：${inkCenters.members
          .map(
            (member) => `${member.label} ${formatDirectionalOffset('x', member.inkCenterOffset)}`
          )
          .join('、')}${inkCenters.designQuestion ? ` · ${inkCenters.designQuestion}` : ''}`
      : undefined;
    return [
      {
        ...representative,
        requiresReview: classification !== 'optical-residual',
        classification,
        ledgerStatus,
        ...(baseline === undefined ? {} : { baselineOffset: baseline }),
        currentOffset: finding.offset,
        captureCount: finding.captureCount,
        totalCaptureCount: finding.totalCaptureCount,
        ...(dimensionSensitivity.length > 0 ? { dimensionSensitivity } : {}),
        ...(repairProposal ? { repairProposal } : {}),
        ...(inkCenterWitness ? { inkCenterWitness } : {}),
        description: `${CLASSIFICATION_LABELS[classification]} · ${finding.label} · ${finding.captureCount}/${finding.totalCaptureCount} 个捕获一致`,
        finding: `[${CLASSIFICATION_LABELS[classification]}] ${finding.label} ${DISCOVERY_ANCHOR_LABELS[finding.anchor as keyof typeof DISCOVERY_ANCHOR_LABELS] ?? finding.anchor} ${direction} · ${finding.evidence.length} 条 evidence${repairFinding}${dimensionFinding}${boxModelFinding}`,
      },
    ];
  });
  displayedDetails.push(...details.filter((detail) => detail.kind === 'measurement-model'));

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
    coverage: {
      scope: 'authenticated-desktop-web-chat-workspace',
      status: 'complete-for-scope',
      captures: coverageCaptures,
      exclusions: GEOMETRY_COVERAGE_EXCLUSIONS,
    },
    discoverySurfaces: discoverySurfaces.map((surface) => ({
      ...surface,
      railDiscovery: surface.railDiscovery.map((scope) => ({
        ...scope,
        capturedScope: (() => {
          // The embedded payload is what the browser parses on open: the raw
          // box-model nodes and Y candidates belong to capture.json, which the
          // pipeline reads, not to the page a reviewer scrolls.
          const {
            boxModelNodes: _boxModelNodes,
            blockCandidates: _blockCandidates,
            ...capturedScope
          } = scope.capturedScope;
          return capturedScope;
        })(),
      })),
    })),
    contractProposals,
    findingDiff,
    yAxisParity,
    markerRemoval,
    ...(skippedYCards.length > 0 ? { skippedYCards } : {}),
    qualityMetrics,
    ledger,
    compiledContracts,
    pixelWitnesses,
    geometryViolations,
    details: displayedDetails.map(
      ({
        kind,
        requiresReview,
        classification,
        findingKey,
        ledgerStatus,
        baselineOffset,
        currentOffset,
        captureCount,
        totalCaptureCount,
        dimensionSensitivity,
        repairProposal,
        inkCenterWitness,
        id,
        title,
        description,
        finding,
        clip,
        images,
      }) => {
        const captureId = detailCaptureIds.get(id);
        if (!captureId) throw new Error(`Geometry detail ${id} has no replayable capture`);
        return {
          kind,
          requiresReview,
          ...(classification ? { classification } : {}),
          ...(findingKey ? { findingKey } : {}),
          ...(ledgerStatus ? { ledgerStatus } : {}),
          ...(baselineOffset === undefined ? {} : { baselineOffset }),
          ...(currentOffset === undefined ? {} : { currentOffset }),
          ...(captureCount === undefined ? {} : { captureCount }),
          ...(totalCaptureCount === undefined ? {} : { totalCaptureCount }),
          ...(dimensionSensitivity && dimensionSensitivity.length > 0
            ? { dimensionSensitivity }
            : {}),
          ...(repairProposal ? { repairProposal } : {}),
          ...(inkCenterWitness ? { inkCenterWitness } : {}),
          id,
          captureId,
          title,
          description,
          finding,
          clip,
          images,
        };
      }
    ),
  };

  await writeFile(
    path.join(outputDirectory, 'report-data.json'),
    `${JSON.stringify(reportData, null, 2)}\n`,
    'utf8'
  );
  if (unexpectedNetworkRequests.length > 0) {
    throw new Error(`Unexpected network requests: ${unexpectedNetworkRequests.join(', ')}`);
  }
  await context.close();
});
