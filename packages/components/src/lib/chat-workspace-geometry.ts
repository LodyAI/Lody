/**
 * Mathematical layout contract for the authenticated Web chat workspace.
 *
 * This module does not render layout. Production components remain ordinary
 * Flex/Grid boxes; development overlays and browser tests consume this same
 * contract to draw or validate the resulting geometry.
 */

export type GeometryRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Attribute read by development overlays and browser validators. */
export const CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE = 'data-geometry-anchor';

export const CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES = {
  group: 'data-geometry-baseline-group',
  name: 'data-geometry-baseline-name',
  member: 'data-geometry-baseline-member',
} as const;

/** DOM declarations consumed by semantic-alignment measurement. */
export const CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES = {
  x: 'data-geometry-align-x',
  y: 'data-geometry-align-y',
  instance: 'data-geometry-align-instance',
  member: 'data-geometry-align-member',
  visual: 'data-geometry-align-visual',
} as const;

/** Marks a DOM region in which repeated horizontal rails may be discovered. */
export const CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE = 'data-geometry-discovery-scope';

export type SemanticAlignmentAnchor =
  | 'inline-start'
  | 'inline-center'
  | 'inline-end'
  | 'block-start'
  | 'block-center'
  | 'block-end'
  | 'text-baseline'
  | 'visual-center';

export type SemanticAlignmentAxis = 'x' | 'y';

export type SemanticAlignmentPolicy = 'observe' | 'enforce';

export type SemanticAlignmentScope = 'global' | 'instance';

export type SemanticAlignmentRule = Readonly<{
  name: string;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  scope: SemanticAlignmentScope;
  minMembers: number;
  tolerance: number;
  policy: SemanticAlignmentPolicy;
}>;

/**
 * Central alignment contract. Production DOM declares only membership; this
 * table owns coordinate semantics and the observe/enforce migration phase.
 */
export const CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS = {
  sidebarPrimaryTrailingRailEnd: {
    name: 'sidebar.primary-trailing-rail-end',
    axis: 'x',
    anchor: 'inline-end',
    scope: 'global',
    minMembers: 3,
    tolerance: 0.5,
    policy: 'observe',
  },
  sidebarRowContentCenter: {
    name: 'sidebar.row.content-center',
    axis: 'y',
    anchor: 'block-center',
    scope: 'instance',
    minMembers: 2,
    tolerance: 0.5,
    policy: 'observe',
  },
} as const satisfies Record<string, SemanticAlignmentRule>;

export const CHAT_WORKSPACE_GEOMETRY_ANCHORS = {
  workspaceShell: 'workspace-shell',
  sidebarSlot: 'workspace-sidebar-slot',
  sidebarCard: 'workspace-sidebar-card',
  mainPane: 'workspace-main-pane',
  chatLanding: 'chat-landing',
  greetingRegion: 'chat-greeting-region',
  composerBand: 'chat-composer-band',
  conversationColumn: 'chat-conversation-column',
} as const;

export type ChatWorkspaceGeometryAnchor =
  (typeof CHAT_WORKSPACE_GEOMETRY_ANCHORS)[keyof typeof CHAT_WORKSPACE_GEOMETRY_ANCHORS];

export type ChatWorkspaceGeometrySnapshot = Partial<
  Record<ChatWorkspaceGeometryAnchor, GeometryRect>
>;

export type MainPaneGridRangeName = 'compact' | 'medium' | 'wide';

export type MainPaneGridRange = Readonly<{
  name: MainPaneGridRangeName;
  minWidth: number;
  columns: number;
  margin: number;
  gutter: number;
}>;

export type ChatWorkspaceGeometryVerificationCase = Readonly<{
  name: string;
  viewport: Readonly<{ width: number; height: number }>;
  sidebar: 'expanded' | 'collapsed';
  sidebarWidth?: number;
  expectedGridRange: MainPaneGridRangeName;
}>;

/**
 * The single numeric source for workspace geometry. Grid breakpoints resolve
 * against the measured main pane, never against the viewport: resizing or
 * collapsing the sidebar must therefore recompute the active range.
 */
export const CHAT_WORKSPACE_GEOMETRY_SPEC = {
  version: 1,
  spacingStep: 4,
  defaultTolerance: 0.5,
  sidebar: {
    minWidth: 240,
    defaultWidth: 280,
    maxWidth: 420,
    cardInset: {
      top: 8,
      right: 4,
      bottom: 8,
      left: 8,
    },
    grid: {
      columns: 4,
      margin: 12,
      gutter: 8,
    },
  },
  mainPaneGrid: {
    maxContentWidth: 1440,
    ranges: [
      { name: 'compact', minWidth: 0, columns: 4, margin: 16, gutter: 16 },
      { name: 'medium', minWidth: 640, columns: 8, margin: 24, gutter: 20 },
      { name: 'wide', minWidth: 1024, columns: 12, margin: 32, gutter: 24 },
    ] satisfies readonly MainPaneGridRange[],
  },
  conversation: {
    maxOuterWidth: 736,
    compactHorizontalInset: 12,
    regularHorizontalInset: 16,
    regularInsetMinWidth: 640,
  },
  verificationCases: [
    {
      name: 'narrow-expanded',
      viewport: { width: 768, height: 768 },
      sidebar: 'expanded',
      sidebarWidth: 280,
      expectedGridRange: 'compact',
    },
    {
      name: 'standard-expanded',
      viewport: { width: 1280, height: 800 },
      sidebar: 'expanded',
      sidebarWidth: 280,
      expectedGridRange: 'medium',
    },
    {
      name: 'wide-expanded',
      viewport: { width: 1440, height: 900 },
      sidebar: 'expanded',
      sidebarWidth: 280,
      expectedGridRange: 'wide',
    },
    {
      name: 'content-cap-expanded',
      viewport: { width: 1920, height: 1080 },
      sidebar: 'expanded',
      sidebarWidth: 280,
      expectedGridRange: 'wide',
    },
    {
      name: 'boundary-collapsed',
      viewport: { width: 1024, height: 768 },
      sidebar: 'collapsed',
      expectedGridRange: 'wide',
    },
  ] satisfies readonly ChatWorkspaceGeometryVerificationCase[],
} as const;

export type CalculatedGridTrack = Readonly<{
  index: number;
  rect: GeometryRect;
}>;

export type CalculatedMainPaneGrid = Readonly<{
  range: MainPaneGridRange;
  pane: GeometryRect;
  content: GeometryRect;
  visibleMargin: number;
  columnWidth: number;
  columns: readonly CalculatedGridTrack[];
  gutters: readonly GeometryRect[];
  /** Both edges of every column, ordered from left to right. */
  columnGuides: readonly number[];
}>;

export type CalculatedSidebarGrid = Readonly<{
  range: Readonly<{
    name: 'sidebar';
    columns: number;
    margin: number;
    gutter: number;
  }>;
  pane: GeometryRect;
  content: GeometryRect;
  visibleMargin: number;
  columnWidth: number;
  columns: readonly CalculatedGridTrack[];
  gutters: readonly GeometryRect[];
  columnGuides: readonly number[];
}>;

export type GridPlacement = Readonly<{
  anchor: ChatWorkspaceGeometryAnchor;
  /** One-based column index. */
  start: number;
  span: number;
}>;

export type SpacingMeasurement = Readonly<{
  /** Stable diagnostic name, such as `composer.padding-bottom`. */
  name: string;
  value: number;
}>;

export const CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES = [
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'rowGap',
  'columnGap',
  'lineHeight',
] as const;

export type ChatWorkspaceSpacingAuditProperty =
  (typeof CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES)[number];

export type SemanticBaselineMode = 'center' | 'text';

export const CHAT_WORKSPACE_SUBPIXEL_JITTER_THRESHOLD = 1;

export type SemanticGeometryStatus =
  | 'aligned'
  | 'sub-pixel-jitter'
  | 'violation'
  | 'insufficient-evidence';

export type SemanticBaselineMemberMeasurement = Readonly<{
  name: string;
  coordinate: number;
}>;

export type SemanticBaselineGroupMeasurement = Readonly<{
  name: string;
  mode: SemanticBaselineMode;
  /** Coordinates are snapped to this physical-pixel grid before comparison. */
  deviceScaleFactor?: number;
  members: readonly SemanticBaselineMemberMeasurement[];
}>;

export type SemanticBaselineGroupResult = Readonly<{
  name: string;
  mode: SemanticBaselineMode;
  line: number;
  spread: number;
  aligned: boolean;
  measurable: boolean;
  status: SemanticGeometryStatus;
  members: readonly Readonly<SemanticBaselineMemberMeasurement & { delta: number }>[];
}>;

export type SemanticAlignmentGroupMeasurement = Readonly<{
  name: string;
  instance: string | null;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  minMembers: number;
  tolerance: number;
  policy: SemanticAlignmentPolicy;
  /** Coordinates are snapped to this physical-pixel grid before comparison. */
  deviceScaleFactor?: number;
  members: readonly SemanticBaselineMemberMeasurement[];
}>;

export type SemanticAlignmentGroupResult = Readonly<{
  name: string;
  instance: string | null;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  minMembers: number;
  tolerance: number;
  policy: SemanticAlignmentPolicy;
  line: number;
  aligned: boolean;
  measurable: boolean;
  status: SemanticGeometryStatus;
  spread: number;
  members: readonly Readonly<SemanticBaselineMemberMeasurement & { delta: number }>[];
}>;

export type AlignmentRailCandidateAnchor = 'inline-start' | 'inline-center' | 'inline-end';
export type AlignmentRailCandidateSpace = 'ink' | 'layout-box';

export type AlignmentRailCandidate = Readonly<{
  elementId: string;
  /** Stable row identity so nested boxes on one row cannot inflate support. */
  rowId: string;
  /** Structural family shared by instances of the same visual row shape. */
  rowFamily?: string;
  /** Nearest visual partition inside the discovery scope. */
  sectionId?: string;
  /** Geometry-derived visual role; semantic contract names never enter discovery. */
  kind?: string;
  /** Centered text contributes only its center; flow text contributes only its edges. */
  alignmentMode?: 'flow' | 'centered';
  /** Candidates from different coordinate spaces never establish or join the same rail. */
  space?: AlignmentRailCandidateSpace;
  anchor: AlignmentRailCandidateAnchor;
  coordinate: number;
  yStart: number;
  yEnd: number;
}>;

export type AlignmentRailDiscoveryOptions = Readonly<{
  /** Maximum distance at which a candidate can attach to a stable rail mode. */
  mergeTolerance?: number;
  /** Maximum distance from the median at which a member supports the rail. */
  inlierTolerance?: number;
  minSupport?: number;
  minVerticalSpan?: number;
  /** Region height used to score how much of the region the rail traverses. */
  scopeHeight?: number;
}>;

export type DiscoveredAlignmentRail = Readonly<{
  anchor: AlignmentRailCandidateAnchor;
  space?: AlignmentRailCandidateSpace;
  line: number;
  support: number;
  sampleSize: number;
  verticalSpan: number;
  confidence: number;
  members: readonly Readonly<AlignmentRailCandidate & { delta: number; outlier: boolean }>[];
  outliers: readonly Readonly<AlignmentRailCandidate & { delta: number; outlier: true }>[];
}>;

export type AlignmentRailFamily = Readonly<{
  rails: readonly DiscoveredAlignmentRail[];
}>;

/**
 * Vertical anchors. `block-*` read the primitive's measured box, `visual-center`
 * the ink a reader actually sees (cap-height band for text, transformed path
 * bounds for an SVG, box centre for an image or field) and `text-baseline` the
 * font baseline. `block-center` and `visual-center` are BOTH kept: a text box's
 * centre is content independent but line-height dependent, so only the visual
 * centre may be compared against an icon.
 */
export type BlockRailCandidateAnchor =
  | 'block-start'
  | 'block-center'
  | 'block-end'
  | 'visual-center'
  | 'text-baseline';

export type BlockRailCandidate = Readonly<{
  elementId: string;
  /** The DOM row this primitive renders in. A PRIOR, never eligibility. */
  rowId: string;
  /** Structural family shared by instances of the same visual row shape. */
  rowFamily?: string;
  /** Nearest visual partition inside the discovery scope. */
  sectionId?: string;
  /** Nearest declared discovery scope; with `rowFamily`, the DOM prior. */
  scope?: string;
  /** Geometry-derived visual role; semantic contract names never enter discovery. */
  kind?: string;
  space?: AlignmentRailCandidateSpace;
  anchor: BlockRailCandidateAnchor;
  /** Vertical page coordinate of this anchor. */
  coordinate: number;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}>;

export type BlockRailDiscoveryOptions = Readonly<{
  /** Maximum distance from the row median at which a member supports the rail. */
  inlierTolerance?: number;
  minMembers?: number;
  /** Members a rail needs when no DOM row vouches for the comparison. */
  crossFamilyMinMembers?: number;
  /** Coordinates are snapped to this physical-pixel grid before comparison. */
  deviceScaleFactor?: number;
}>;

/**
 * What let these primitives be compared at all.
 *
 * - `row-instance`: every member renders in ONE DOM row. That prior is strong
 *   enough on its own, so two members and one capture are a rail.
 * - `cross-family`: a geometric row put members of DIFFERENT row families or
 *   scopes on one line, and no DOM structure says they belong together. The
 *   claim is the same; only the evidence behind it is weaker.
 */
export type BlockRailEvidence = 'row-instance' | 'cross-family';

export type DiscoveredBlockRail = Readonly<{
  rowId: string;
  rowFamily?: string;
  sectionId?: string;
  evidence: BlockRailEvidence;
  anchor: BlockRailCandidateAnchor;
  line: number;
  spread: number;
  support: number;
  sampleSize: number;
  horizontalSpan: number;
  members: readonly Readonly<BlockRailCandidate & { delta: number; outlier: boolean }>[];
  outliers: readonly Readonly<BlockRailCandidate & { delta: number; outlier: true }>[];
}>;

/**
 * How much of BOTH vertical extents has to fall inside the other for them to be
 * on ONE line: the same "at least half" `selectVisualRowSlots` asks of a row
 * slot, so a row and a rail cannot mean different things by it. That function
 * repeats the literal because capture serializes it into the page, where this
 * binding does not exist; keep the two in step.
 */
export const GEOMETRY_ROW_BAND_OVERLAP = 0.5;

/** One element's vertical extent: all a geometric row is made of. */
export type GeometricRowExtent = Readonly<{ id: string; yStart: number; yEnd: number }>;

export type LayoutTopologyNode = Readonly<{
  id: string;
  parentId: string | null;
  order: number;
  depth: number;
  tag: string;
  role: string | null;
  candidateKind: string | null;
  rect: GeometryRect;
}>;

export type RepeatedLayoutScope = Readonly<{
  id: string;
  signature: string;
  parentId: string;
  instanceIds: readonly string[];
  rect: GeometryRect;
  similarity: number;
  confidence: number;
}>;

export type RepeatedLayoutScopeDiscoveryOptions = Readonly<{
  minInstances?: number;
  minSimilarity?: number;
  minVerticalSpan?: number;
  tokenDepth?: number;
  maxScopes?: number;
}>;

export type AlignmentRailCapture = Readonly<{
  captureId: string;
  scopeKey: string;
  scopeRect: GeometryRect;
  rails: readonly DiscoveredAlignmentRail[];
  /** Raw start/center/end families preserve evidence until cross-capture canonicalization. */
  railFamilies?: readonly AlignmentRailFamily[];
}>;

export type AlignmentRailContractProposal = Readonly<{
  id: string;
  kind: 'alignment-rail';
  scopeKey: string;
  anchor: AlignmentRailCandidateAnchor;
  normalizedLine: number;
  normalizedTolerance: number;
  confidence: number;
  policy: 'proposal';
  evidence: Readonly<{
    captureIds: readonly string[];
    captureCoverage: number;
    support: number;
    sampleSize: number;
    outlierCount: number;
    maxNormalizedResidual: number;
  }>;
}>;

export type AlignmentRailContractInferenceOptions = Readonly<{
  minCaptures?: number;
  mergeTolerance?: number;
  /** Absolute cap applied after converting the normalized tolerance to pixels. */
  maxPixelMergeTolerance?: number;
  minConfidence?: number;
}>;

export type ChatWorkspaceGeometryValidationOptions = Readonly<{
  sidebar: 'expanded' | 'collapsed';
  tolerance?: number;
  gridPlacements?: readonly GridPlacement[];
  /**
   * Sizes, gaps, or insets to check against the rhythm. Absolute page Y
   * coordinates must not be supplied because dynamic centering may move them.
   */
  spacingMeasurements?: readonly SpacingMeasurement[];
}>;

export type GeometryViolationCode =
  | 'missing-anchor'
  | 'invalid-rect'
  | 'edge-alignment'
  | 'containment'
  | 'width-range'
  | 'horizontal-centering'
  | 'expected-width'
  | 'grid-placement'
  | 'spacing-rhythm';

export type GeometryViolation = Readonly<{
  code: GeometryViolationCode;
  path: string;
  message: string;
  expected?: number;
  actual?: number;
  delta?: number;
}>;

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number; received ${value}`);
  }
}

function right(rect: GeometryRect): number {
  return rect.x + rect.width;
}

function bottom(rect: GeometryRect): number {
  return rect.y + rect.height;
}

function centerX(rect: GeometryRect): number {
  return rect.x + rect.width / 2;
}

function isValidRect(rect: GeometryRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

/** Resolve the design-grid range from main-pane width, not viewport width. */
export function resolveMainPaneGridRange(mainPaneWidth: number): MainPaneGridRange {
  assertFiniteNonNegative(mainPaneWidth, 'mainPaneWidth');

  const ranges = CHAT_WORKSPACE_GEOMETRY_SPEC.mainPaneGrid.ranges;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range && mainPaneWidth >= range.minWidth) return range;
  }

  // The compact range starts at zero, so this branch is unreachable while the
  // spec remains valid. Keep the failure explicit if the table is edited.
  throw new Error('The main-pane grid must define a range starting at width 0');
}

/**
 * Calculate column and gutter rectangles in document coordinates. The visible
 * margin grows symmetrically once the configured content maximum is reached.
 */
export function calculateMainPaneGrid(pane: GeometryRect): CalculatedMainPaneGrid {
  if (!isValidRect(pane)) throw new RangeError('pane must be a finite rectangle');

  const range = resolveMainPaneGridRange(pane.width);
  const availableContentWidth = Math.max(0, pane.width - range.margin * 2);
  const contentWidth = Math.min(
    availableContentWidth,
    CHAT_WORKSPACE_GEOMETRY_SPEC.mainPaneGrid.maxContentWidth
  );
  const visibleMargin = (pane.width - contentWidth) / 2;
  const totalGutterWidth = range.gutter * (range.columns - 1);
  if (contentWidth < totalGutterWidth) {
    throw new RangeError(
      `Main pane is too narrow for the ${range.name} grid: ` +
        `${contentWidth}px content cannot contain ${totalGutterWidth}px of gutters`
    );
  }
  const columnWidth = (contentWidth - totalGutterWidth) / range.columns;
  const content: GeometryRect = {
    x: pane.x + visibleMargin,
    y: pane.y,
    width: contentWidth,
    height: pane.height,
  };
  const columns: CalculatedGridTrack[] = [];
  const gutters: GeometryRect[] = [];
  const columnGuides: number[] = [];

  for (let index = 0; index < range.columns; index += 1) {
    const x = content.x + index * (columnWidth + range.gutter);
    const rect = { x, y: pane.y, width: columnWidth, height: pane.height };
    columns.push({ index: index + 1, rect });
    columnGuides.push(x, x + columnWidth);

    if (index < range.columns - 1) {
      gutters.push({
        x: x + columnWidth,
        y: pane.y,
        width: range.gutter,
        height: pane.height,
      });
    }
  }

  return {
    range,
    pane,
    content,
    visibleMargin,
    columnWidth,
    columns,
    gutters,
    columnGuides,
  };
}

/** Calculate the Sidebar card's four-column local design grid. */
export function calculateSidebarGrid(card: GeometryRect): CalculatedSidebarGrid {
  if (!isValidRect(card)) throw new RangeError('card must be a finite rectangle');

  const definition = CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.grid;
  const contentWidth = card.width - definition.margin * 2;
  const totalGutterWidth = definition.gutter * (definition.columns - 1);
  if (contentWidth < totalGutterWidth) {
    throw new RangeError(
      `Sidebar card is too narrow for its local grid: ${contentWidth}px content cannot contain ` +
        `${totalGutterWidth}px of gutters`
    );
  }

  const columnWidth = (contentWidth - totalGutterWidth) / definition.columns;
  const content: GeometryRect = {
    x: card.x + definition.margin,
    y: card.y,
    width: contentWidth,
    height: card.height,
  };
  const columns: CalculatedGridTrack[] = [];
  const gutters: GeometryRect[] = [];
  const columnGuides: number[] = [];

  for (let index = 0; index < definition.columns; index += 1) {
    const x = content.x + index * (columnWidth + definition.gutter);
    const rect = { x, y: card.y, width: columnWidth, height: card.height };
    columns.push({ index: index + 1, rect });
    columnGuides.push(x, x + columnWidth);
    if (index < definition.columns - 1) {
      gutters.push({
        x: x + columnWidth,
        y: card.y,
        width: definition.gutter,
        height: card.height,
      });
    }
  }

  return {
    range: { name: 'sidebar', ...definition },
    pane: card,
    content,
    visibleMargin: definition.margin,
    columnWidth,
    columns,
    gutters,
    columnGuides,
  };
}

/** Calculate the exact rectangle occupied by a one-based grid span. */
export function calculateGridPlacementRect(
  grid: CalculatedMainPaneGrid,
  start: number,
  span: number
): GeometryRect {
  if (!Number.isInteger(start) || !Number.isInteger(span) || start < 1 || span < 1) {
    throw new RangeError('Grid start and span must be positive integers');
  }
  if (start + span - 1 > grid.range.columns) {
    throw new RangeError(
      `Grid placement ${start} / span ${span} exceeds ${grid.range.columns} columns`
    );
  }

  const first = grid.columns[start - 1];
  const last = grid.columns[start + span - 2];
  if (!first || !last) throw new RangeError('Grid placement could not be resolved');

  return {
    x: first.rect.x,
    y: grid.pane.y,
    width: right(last.rect) - first.rect.x,
    height: grid.pane.height,
  };
}

/** Horizontal content inset used inside the centered conversation column. */
export function resolveConversationHorizontalInset(mainPaneWidth: number): number {
  assertFiniteNonNegative(mainPaneWidth, 'mainPaneWidth');
  return mainPaneWidth >= CHAT_WORKSPACE_GEOMETRY_SPEC.conversation.regularInsetMinWidth
    ? CHAT_WORKSPACE_GEOMETRY_SPEC.conversation.regularHorizontalInset
    : CHAT_WORKSPACE_GEOMETRY_SPEC.conversation.compactHorizontalInset;
}

/** Whether a size, gap, or inset lies on the spacing scale within tolerance. */
export function isSpacingRhythmMultiple(
  value: number,
  spacingStep: number = CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep,
  tolerance: number = CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance
): boolean {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(spacingStep) || spacingStep <= 0) {
    return false;
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  return Math.abs(value - Math.round(value / spacingStep) * spacingStep) <= tolerance;
}

/**
 * Resolve one text group against its median line. Pass/fail uses the complete
 * member spread, so DOM order cannot select the reference member or hide two
 * members that sit on opposite sides of the displayed guide.
 */
export function quantizeGeometryCoordinate(value: number, deviceScaleFactor = 1): number {
  if (!Number.isFinite(value)) throw new RangeError('Geometry coordinate must be finite');
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new RangeError('deviceScaleFactor must be a positive finite number');
  }
  return Math.round(value * deviceScaleFactor) / deviceScaleFactor;
}

export function evaluateSemanticBaselineGroup(
  group: SemanticBaselineGroupMeasurement,
  tolerance: number = CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance
): SemanticBaselineGroupResult {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a finite, non-negative number');
  }
  const coordinates = group.members.map((member) => {
    if (!Number.isFinite(member.coordinate)) {
      throw new RangeError(`${group.name}.${member.name} must have a finite coordinate`);
    }
    return group.deviceScaleFactor === undefined
      ? member.coordinate
      : quantizeGeometryCoordinate(member.coordinate, group.deviceScaleFactor);
  });
  const sorted = [...coordinates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const line =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
  const members = group.members.map((member, index) => {
    const coordinate = coordinates[index] ?? member.coordinate;
    return { ...member, coordinate, delta: Math.abs(coordinate - line) };
  });
  const spread = sorted.length < 2 ? 0 : (sorted.at(-1) ?? 0) - (sorted[0] ?? 0);
  const measurable = members.length >= 2;
  const status: SemanticGeometryStatus = !measurable
    ? 'insufficient-evidence'
    : spread <= tolerance
      ? 'aligned'
      : spread <= CHAT_WORKSPACE_SUBPIXEL_JITTER_THRESHOLD
        ? 'sub-pixel-jitter'
        : 'violation';
  return {
    name: group.name,
    mode: group.mode,
    line,
    spread,
    aligned: status === 'aligned',
    measurable,
    status,
    members,
  };
}

/**
 * Compare a repeated semantic slot against one physical line. The median is
 * used only to place the diagnostic guide; pass/fail is based on every member's
 * distance from that line, so DOM order cannot decide which member is "right".
 */
export function evaluateSemanticAlignmentGroup(
  group: SemanticAlignmentGroupMeasurement
): SemanticAlignmentGroupResult {
  if (!Number.isFinite(group.tolerance) || group.tolerance < 0) {
    throw new RangeError('group.tolerance must be a finite, non-negative number');
  }
  if (!Number.isInteger(group.minMembers) || group.minMembers < 2) {
    throw new RangeError('group.minMembers must be an integer greater than one');
  }
  const coordinates = group.members.map((member) => {
    if (!Number.isFinite(member.coordinate)) {
      throw new RangeError(`${group.name}.${member.name} must have a finite coordinate`);
    }
    return group.deviceScaleFactor === undefined
      ? member.coordinate
      : quantizeGeometryCoordinate(member.coordinate, group.deviceScaleFactor);
  });
  const sorted = [...coordinates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const line =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
  const members = group.members.map((member, index) => ({
    ...member,
    coordinate: coordinates[index] ?? member.coordinate,
    delta: Math.abs((coordinates[index] ?? member.coordinate) - line),
  }));
  const spread = sorted.length < 2 ? 0 : (sorted.at(-1) ?? 0) - (sorted[0] ?? 0);
  const measurable = members.length >= group.minMembers;
  const status: SemanticGeometryStatus = !measurable
    ? 'insufficient-evidence'
    : spread <= group.tolerance
      ? 'aligned'
      : spread <= CHAT_WORKSPACE_SUBPIXEL_JITTER_THRESHOLD
        ? 'sub-pixel-jitter'
        : 'violation';
  return {
    name: group.name,
    instance: group.instance,
    axis: group.axis,
    anchor: group.anchor,
    minMembers: group.minMembers,
    tolerance: group.tolerance,
    policy: group.policy,
    line,
    measurable,
    status,
    spread,
    aligned: status === 'aligned',
    members,
  };
}

function stableGeometryHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function unionGeometryRects(rects: readonly GeometryRect[]): GeometryRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: maxX - left, height: maxY - top };
}

function multisetSimilarity(
  first: ReadonlyMap<string, number>,
  second: ReadonlyMap<string, number>
) {
  const keys = new Set([...first.keys(), ...second.keys()]);
  let intersection = 0;
  let total = 0;
  for (const key of keys) {
    const firstCount = first.get(key) ?? 0;
    const secondCount = second.get(key) ?? 0;
    intersection += Math.min(firstCount, secondCount);
    total += firstCount + secondCount;
  }
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * Find vertically repeated sibling subtrees without product-specific selectors.
 * Text and CSS classes are deliberately absent from the topology signature:
 * repeated rows may contain different content while retaining the same slots.
 */
export function discoverRepeatedLayoutScopes(
  nodes: readonly LayoutTopologyNode[],
  options: RepeatedLayoutScopeDiscoveryOptions = {}
): readonly RepeatedLayoutScope[] {
  const minInstances = options.minInstances ?? 3;
  const minSimilarity = options.minSimilarity ?? 0.72;
  const minVerticalSpan = options.minVerticalSpan ?? 48;
  const tokenDepth = options.tokenDepth ?? 3;
  const maxScopes = options.maxScopes ?? 12;
  if (!Number.isInteger(minInstances) || minInstances < 3) {
    throw new RangeError('minInstances must be an integer of at least three');
  }
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new RangeError('minSimilarity must be between zero and one');
  }
  if (!Number.isFinite(minVerticalSpan) || minVerticalSpan < 0) {
    throw new RangeError('minVerticalSpan must be a finite, non-negative number');
  }
  if (!Number.isInteger(tokenDepth) || tokenDepth < 1) {
    throw new RangeError('tokenDepth must be a positive integer');
  }
  if (!Number.isInteger(maxScopes) || maxScopes < 1) {
    throw new RangeError('maxScopes must be a positive integer');
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, LayoutTopologyNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(
      (first, second) => first.order - second.order || first.id.localeCompare(second.id)
    );
  }

  const tokenCache = new Map<string, ReadonlyMap<string, number>>();
  const topologyTokens = (rootId: string): ReadonlyMap<string, number> => {
    const cached = tokenCache.get(rootId);
    if (cached) return cached;
    const root = byId.get(rootId);
    if (!root) return new Map();
    const tokens = new Map<string, number>();
    const queue: Array<Readonly<{ node: LayoutTopologyNode; relativeDepth: number }>> = [
      { node: root, relativeDepth: 0 },
    ];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const { node, relativeDepth } = current;
      const token = [relativeDepth, node.tag, node.role ?? '', node.candidateKind ?? ''].join(':');
      tokens.set(token, (tokens.get(token) ?? 0) + 1);
      if (relativeDepth >= tokenDepth) continue;
      for (const child of childrenByParent.get(node.id) ?? []) {
        queue.push({ node: child, relativeDepth: relativeDepth + 1 });
      }
    }
    tokenCache.set(rootId, tokens);
    return tokens;
  };

  const candidateDescendantCache = new Map<string, boolean>();
  const hasCandidateDescendant = (rootId: string): boolean => {
    const cached = candidateDescendantCache.get(rootId);
    if (cached !== undefined) return cached;
    const root = byId.get(rootId);
    const result =
      (root?.candidateKind ?? null) !== null ||
      (childrenByParent.get(rootId) ?? []).some((child) => hasCandidateDescendant(child.id));
    candidateDescendantCache.set(rootId, result);
    return result;
  };

  const proposals: RepeatedLayoutScope[] = [];
  for (const [parentId, siblings] of childrenByParent) {
    const eligible = siblings.filter(
      (node) => node.rect.width > 0 && node.rect.height > 0 && hasCandidateDescendant(node.id)
    );
    const assigned = new Set<string>();
    let groupIndex = 0;
    for (const seed of eligible) {
      if (assigned.has(seed.id)) continue;
      const seedTokens = topologyTokens(seed.id);
      const instances = eligible.filter(
        (candidate) =>
          !assigned.has(candidate.id) &&
          multisetSimilarity(seedTokens, topologyTokens(candidate.id)) >= minSimilarity
      );
      if (instances.length < minInstances) continue;
      const ordered = [...instances].sort(
        (first, second) =>
          first.rect.y - second.rect.y || first.rect.x - second.rect.x || first.order - second.order
      );
      const distinctCenters = new Set(
        ordered.map((node) => Number((node.rect.y + node.rect.height / 2).toFixed(1)))
      );
      if (distinctCenters.size < minInstances) continue;
      const rect = unionGeometryRects(ordered.map((node) => node.rect));
      if (rect.height < minVerticalSpan) continue;

      const referenceLeft = median(ordered.map((node) => node.rect.x));
      const referenceWidth = median(ordered.map((node) => node.rect.width));
      const geometryMatches = ordered.filter((node) => {
        const widthRatio =
          referenceWidth === 0
            ? 0
            : Math.min(node.rect.width, referenceWidth) / Math.max(node.rect.width, referenceWidth);
        return (
          widthRatio >= 0.6 &&
          Math.abs(node.rect.x - referenceLeft) <= Math.max(8, referenceWidth * 0.2)
        );
      }).length;
      if (geometryMatches < minInstances) continue;

      const similarities = ordered.map((node) =>
        multisetSimilarity(seedTokens, topologyTokens(node.id))
      );
      const similarity = similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
      const geometryConfidence = geometryMatches / ordered.length;
      const parent = byId.get(parentId);
      const structureSignature = [...seedTokens.entries()]
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([token, count]) => `${token}*${count}`)
        .join('|');
      const context: string[] = [];
      for (let ancestor = parent; ancestor && context.length < 4; ) {
        context.unshift(`${ancestor.tag}[${ancestor.role ?? ''}]`);
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
      const signature = `${context.join('>')}::${structureSignature}`;
      const id = `auto.repeated:${parent?.tag ?? 'root'}:${stableGeometryHash(signature)}:${parentId}:${groupIndex}`;
      groupIndex += 1;
      proposals.push({
        id,
        signature,
        parentId,
        instanceIds: ordered.map((node) => node.id),
        rect,
        similarity,
        confidence: similarity * geometryConfidence,
      });
      ordered.forEach((node) => assigned.add(node.id));
    }
  }

  return proposals
    .sort((first, second) => {
      const firstDepth = byId.get(first.parentId)?.depth ?? 0;
      const secondDepth = byId.get(second.parentId)?.depth ?? 0;
      return (
        second.confidence - first.confidence ||
        second.instanceIds.length - first.instanceIds.length ||
        secondDepth - firstDepth ||
        first.id.localeCompare(second.id)
      );
    })
    .filter((scope, index, scopes) => {
      const members = new Set(scope.instanceIds);
      return !scopes.slice(0, index).some((existing) => {
        if (existing.parentId !== scope.parentId) return false;
        const overlap = existing.instanceIds.filter((id) => members.has(id)).length;
        return overlap / Math.min(existing.instanceIds.length, scope.instanceIds.length) > 0.5;
      });
    })
    .slice(0, maxScopes);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Discover repeated horizontal alignment rails without assigning layout intent.
 * Candidates are grouped independently by anchor kind and coordinate space. Repeated coordinate
 * modes establish rails before nearby singleton observations are attached to
 * the nearest compatible mode. A rail supported by one visual primitive kind
 * only accepts that kind unless all members share a repeated row family.
 * This keeps stable indentation levels separate and prevents an unrelated icon
 * from attaching to a nearby text rail. Flow text can define start or end edges,
 * while centered text can define only its center. The
 * result is diagnostic only: callers decide whether a reviewed rail should
 * later become an explicit semantic contract.
 */
export function discoverAlignmentRails(
  candidates: readonly AlignmentRailCandidate[],
  options: AlignmentRailDiscoveryOptions = {}
): readonly DiscoveredAlignmentRail[] {
  const mergeTolerance = options.mergeTolerance ?? 2;
  const inlierTolerance = options.inlierTolerance ?? 0.5;
  const minSupport = options.minSupport ?? 3;
  const minVerticalSpan = options.minVerticalSpan ?? 24;
  const scopeHeight = options.scopeHeight;
  if (!Number.isFinite(mergeTolerance) || mergeTolerance < 0) {
    throw new RangeError('mergeTolerance must be a finite, non-negative number');
  }
  if (!Number.isFinite(inlierTolerance) || inlierTolerance < 0) {
    throw new RangeError('inlierTolerance must be a finite, non-negative number');
  }
  if (!Number.isInteger(minSupport) || minSupport < 2) {
    throw new RangeError('minSupport must be an integer greater than one');
  }
  if (!Number.isFinite(minVerticalSpan) || minVerticalSpan < 0) {
    throw new RangeError('minVerticalSpan must be a finite, non-negative number');
  }
  if (scopeHeight !== undefined && (!Number.isFinite(scopeHeight) || scopeHeight <= 0)) {
    throw new RangeError('scopeHeight must be a positive finite number');
  }

  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.coordinate) ||
      !Number.isFinite(candidate.yStart) ||
      !Number.isFinite(candidate.yEnd) ||
      candidate.yEnd < candidate.yStart
    ) {
      throw new RangeError(`${candidate.elementId}.${candidate.anchor} has invalid geometry`);
    }
  }

  const byAnchorAndSpace = new Map<string, AlignmentRailCandidate[]>();
  for (const candidate of candidates) {
    const isText = candidate.kind === 'text' || candidate.kind === 'numeric-text';
    if (
      isText &&
      (candidate.alignmentMode === 'centered'
        ? candidate.anchor !== 'inline-center'
        : candidate.anchor === 'inline-center')
    ) {
      continue;
    }
    const key = `${candidate.anchor}\u0000${candidate.space ?? 'layout-box'}`;
    const members = byAnchorAndSpace.get(key) ?? [];
    members.push(candidate);
    byAnchorAndSpace.set(key, members);
  }

  const rails: DiscoveredAlignmentRail[] = [];
  for (const anchorCandidates of byAnchorAndSpace.values()) {
    const firstCandidate = anchorCandidates[0];
    if (!firstCandidate) continue;
    const anchor = firstCandidate.anchor;
    const space = firstCandidate.space;
    const ordered = [...anchorCandidates].sort(
      (first, second) =>
        first.coordinate - second.coordinate ||
        first.yStart - second.yStart ||
        first.elementId.localeCompare(second.elementId)
    );

    const modeClusters: AlignmentRailCandidate[][] = [];
    const maximumModeSpan = inlierTolerance;
    for (const candidate of ordered) {
      const currentMode = modeClusters.at(-1);
      const modeStart = currentMode?.[0]?.coordinate;
      if (
        !currentMode ||
        modeStart === undefined ||
        candidate.coordinate - modeStart > maximumModeSpan
      ) {
        modeClusters.push([candidate]);
      } else {
        currentMode.push(candidate);
      }
    }

    const stableModes = modeClusters.flatMap((mode) => {
      const initialLine = median(mode.map((member) => member.coordinate));
      const uniqueByRow = new Map<string, AlignmentRailCandidate>();
      for (const candidate of mode) {
        const current = uniqueByRow.get(candidate.rowId);
        if (
          !current ||
          Math.abs(candidate.coordinate - initialLine) < Math.abs(current.coordinate - initialLine)
        ) {
          uniqueByRow.set(candidate.rowId, candidate);
        }
      }
      const uniqueCandidates = [...uniqueByRow.values()];
      const line = median(uniqueCandidates.map((member) => member.coordinate));
      const supporters = uniqueCandidates.filter(
        (member) => Math.abs(member.coordinate - line) <= inlierTolerance
      );
      if (supporters.length < minSupport) return [];
      const kinds = new Set(supporters.flatMap((member) => (member.kind ? [member.kind] : [])));
      const rowFamilies = new Set(
        supporters.flatMap((member) => (member.rowFamily ? [member.rowFamily] : []))
      );
      const sharesKind = kinds.size <= 1;
      const sharesRowFamily =
        rowFamilies.size === 1 && supporters.every((member) => member.rowFamily !== undefined);
      if (!sharesKind && !sharesRowFamily) return [];
      const sectionIds = new Set(
        supporters.flatMap((member) => (member.sectionId ? [member.sectionId] : []))
      );
      if (supporters.length === 2 && sectionIds.size > 1) return [];
      const verticalSpan =
        Math.max(...supporters.map((member) => member.yEnd)) -
        Math.min(...supporters.map((member) => member.yStart));
      if (verticalSpan < minVerticalSpan) return [];
      return [
        {
          line,
          verticalSpan,
          kinds,
          rowFamilies,
        },
      ];
    });

    const assignedByMode = stableModes.map(() => [] as AlignmentRailCandidate[]);
    for (const candidate of ordered) {
      let nearestModeIndex = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const [modeIndex, mode] of stableModes.entries()) {
        const distance = Math.abs(candidate.coordinate - mode.line);
        const identityCompatible =
          candidate.kind === undefined ||
          mode.kinds.size === 0 ||
          mode.kinds.has(candidate.kind) ||
          (candidate.rowFamily !== undefined && mode.rowFamilies.has(candidate.rowFamily));
        if (identityCompatible && distance <= mergeTolerance && distance < nearestDistance) {
          nearestModeIndex = modeIndex;
          nearestDistance = distance;
        }
      }
      if (nearestModeIndex >= 0) assignedByMode[nearestModeIndex]?.push(candidate);
    }

    for (const [modeIndex, mode] of stableModes.entries()) {
      const uniqueByRow = new Map<string, AlignmentRailCandidate>();
      for (const candidate of assignedByMode[modeIndex] ?? []) {
        const current = uniqueByRow.get(candidate.rowId);
        if (
          !current ||
          Math.abs(candidate.coordinate - mode.line) < Math.abs(current.coordinate - mode.line)
        ) {
          uniqueByRow.set(candidate.rowId, candidate);
        }
      }
      const members = [...uniqueByRow.values()]
        .map((member) => {
          const delta = Math.abs(member.coordinate - mode.line);
          return { ...member, delta, outlier: delta > inlierTolerance };
        })
        .sort(
          (first, second) =>
            first.yStart - second.yStart ||
            first.coordinate - second.coordinate ||
            first.elementId.localeCompare(second.elementId)
        );
      const support = members.filter((member) => !member.outlier).length;
      const confidence =
        (support / members.length) *
        (scopeHeight === undefined ? 1 : Math.min(1, mode.verticalSpan / scopeHeight));
      const outliers = members.filter(
        (member): member is AlignmentRailCandidate & { delta: number; outlier: true } =>
          member.outlier
      );
      rails.push({
        anchor,
        ...(space ? { space } : {}),
        line: mode.line,
        support,
        sampleSize: members.length,
        verticalSpan: mode.verticalSpan,
        confidence,
        members,
        outliers,
      });
    }
  }

  return rails.sort(
    (first, second) =>
      second.confidence - first.confidence ||
      second.support - first.support ||
      first.line - second.line ||
      first.anchor.localeCompare(second.anchor)
  );
}

/** One candidate row slot, as capture measures it before any rail exists. */
export type GeometryRowSlotExtent = Readonly<{ top: number; bottom: number }>;

/**
 * A row is a LINE, not a stack. A composer's `label` sitting above its textarea
 * is two lines of one column, and calling it a row makes the distance between
 * those lines a vertical misalignment — which it is not.
 *
 * The test is the row band: the median slot height centred on the row, which is
 * the height an ordinary member of this row has. A slot whose vertical extent
 * overlaps that band by less than half is on another line, so it is not a row
 * member (it may still be measured as an atom outside every row). The surviving
 * indices are returned in input order; a caller needs at least two of them to
 * have a row at all.
 *
 * Keep closure-free: capture serializes this function into the page.
 */
export function selectVisualRowSlots(
  slots: readonly GeometryRowSlotExtent[],
  rowCenter: number,
  // The literal, not `GEOMETRY_ROW_BAND_OVERLAP`: capture serializes this
  // function into the page, where a module binding does not exist.
  minimumBandOverlap = 0.5
): readonly number[] {
  const heights = slots
    .map((slot) => slot.bottom - slot.top)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((first, second) => first - second);
  const middle = Math.floor(heights.length / 2);
  const bandHeight =
    heights.length === 0
      ? 0
      : heights.length % 2 === 1
        ? (heights[middle] ?? 0)
        : ((heights[middle - 1] ?? 0) + (heights[middle] ?? 0)) / 2;
  if (bandHeight <= 0) return slots.map((_slot, index) => index);
  const bandTop = rowCenter - bandHeight / 2;
  const bandBottom = rowCenter + bandHeight / 2;
  return slots.flatMap((slot, index) => {
    const overlap = Math.min(slot.bottom, bandBottom) - Math.max(slot.top, bandTop);
    return overlap / bandHeight >= minimumBandOverlap ? [index] : [];
  });
}

/** Everything about one element a painted-shape decision may read. */
export type GeometryShapePaint = Readonly<{
  width: number;
  height: number;
  /** Rendered element children; a shape is a leaf, it contains nothing. */
  renderedChildCount: number;
  /** Text content; a shape owns no glyph, or it would be a text primitive. */
  text: string;
  backgroundColor: string;
  backgroundImage: string;
  borderWidths: readonly number[];
  borderColors: readonly string[];
}>;

/**
 * A status dot is a `<span>` with a background and nothing inside it. No text
 * range, no SVG path and no image describes it, so discovery cannot see it at
 * all — and a marker rule measuring it can never be removed. It is ink: a
 * rendered leaf, no text, a painted background or border, and at most 24px in
 * BOTH dimensions — a mark, not a surface a row sits on.
 *
 * Keep closure-free: capture serializes this function into the page.
 */
export function isGeometryPaintedShape(paint: GeometryShapePaint): boolean {
  if (paint.renderedChildCount > 0) return false;
  if (paint.text.trim() !== '') return false;
  if (!(paint.width > 0) || !(paint.height > 0)) return false;
  if (paint.width > 24 || paint.height > 24) return false;
  const alpha = (color: string) => {
    if (!color || color === 'transparent' || color === 'none') return 0;
    const channels = color.match(/[\d.]+/g);
    if (!channels) return 0;
    return channels.length >= 4 ? Number(channels[3]) : 1;
  };
  if (alpha(paint.backgroundColor) > 0) return true;
  if (paint.backgroundImage !== '' && paint.backgroundImage !== 'none') return true;
  return paint.borderWidths.some(
    (width, index) => width > 0 && alpha(paint.borderColors[index] ?? '') > 0
  );
}

/**
 * Assign vertical extents to GEOMETRIC rows: the visual lines a reader sees,
 * derived from rendered geometry and nothing else. Returns one row index per
 * input, in input order; an extent with no height belongs to no row (`-1`).
 *
 * An extent joins the row whose MEDIAN band — the median member height centred
 * on the median member centre — it overlaps by at least half OF BOTH, and the
 * best such overlap wins. The median band is what stops a chain:
 * neighbour-to-neighbour transitivity would let a ladder of half-overlapping
 * extents link two lines of different heights into one row, exactly as chaining
 * intermediate coordinates would link two indentation levels into one X rail.
 * Half of BOTH is what stops the other direction: an extent far taller than the
 * row covers its band completely without being on the row's line at all.
 */
export function assignGeometricRows(
  extents: readonly GeometricRowExtent[],
  minimumBandOverlap = GEOMETRY_ROW_BAND_OVERLAP
): readonly number[] {
  const ordered = extents
    .map((extent, index) => ({ extent, index }))
    .filter(
      ({ extent }) =>
        Number.isFinite(extent.yStart) &&
        Number.isFinite(extent.yEnd) &&
        extent.yEnd > extent.yStart
    )
    .sort(
      (first, second) =>
        (first.extent.yStart + first.extent.yEnd) / 2 -
          (second.extent.yStart + second.extent.yEnd) / 2 ||
        first.extent.yStart - second.extent.yStart ||
        first.extent.id.localeCompare(second.extent.id)
    );
  const rows: { centers: number[]; heights: number[] }[] = [];
  const assignment = extents.map(() => -1);
  for (const { extent, index } of ordered) {
    const height = extent.yEnd - extent.yStart;
    const center = (extent.yStart + extent.yEnd) / 2;
    let chosen = -1;
    let chosenOverlap = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row) continue;
      const bandHeight = median(row.heights);
      const bandCenter = median(row.centers);
      const bandStart = bandCenter - bandHeight / 2;
      const bandEnd = bandCenter + bandHeight / 2;
      const shared = Math.min(extent.yEnd, bandEnd) - Math.max(extent.yStart, bandStart);
      // SYMMETRIC: the overlap has to cover half the member AND half the band,
      // which is what dividing by the LARGER of the two says. Dividing by the
      // smaller one let a 44px heading join a 17px row at "100%" — it covered
      // that band completely while the band covered a third of it — and the
      // heading's centre then read 12px off a line it was never on.
      const span = Math.max(height, bandHeight);
      const ratio = span > 0 ? shared / span : 0;
      if (ratio >= minimumBandOverlap && ratio > chosenOverlap) {
        chosen = rowIndex;
        chosenOverlap = ratio;
      }
    }
    if (chosen < 0) {
      rows.push({ centers: [center], heights: [height] });
      chosen = rows.length - 1;
    } else {
      const row = rows[chosen];
      if (row) {
        row.centers.push(center);
        row.heights.push(height);
      }
    }
    assignment[index] = chosen;
  }
  return assignment;
}

/**
 * One rail over the members of one DOM row instance at one anchor: the rule
 * that has always decided a Y rail, unchanged. Every member is vouched for by
 * the same rendered row, so two of them and one capture are enough.
 */
function discoverRowInstanceRails(
  candidates: readonly BlockRailCandidate[],
  options: Readonly<{ inlierTolerance: number; minMembers: number; deviceScaleFactor: number }>
): DiscoveredBlockRail[] {
  const { inlierTolerance, minMembers, deviceScaleFactor } = options;
  const byRowAndAnchor = new Map<string, BlockRailCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.rowId} ${candidate.anchor}`;
    const members = byRowAndAnchor.get(key) ?? [];
    members.push(candidate);
    byRowAndAnchor.set(key, members);
  }

  const rails: DiscoveredBlockRail[] = [];
  for (const rowCandidates of byRowAndAnchor.values()) {
    // One member per primitive: an element that reported the same anchor twice
    // must not double its own vote for the row median.
    const uniqueByElement = new Map<string, BlockRailCandidate>();
    for (const candidate of rowCandidates) {
      if (!uniqueByElement.has(candidate.elementId))
        uniqueByElement.set(candidate.elementId, candidate);
    }
    const snapped = [...uniqueByElement.values()].map((candidate) => ({
      ...candidate,
      coordinate: quantizeGeometryCoordinate(candidate.coordinate, deviceScaleFactor),
    }));
    if (snapped.length < minMembers) continue;
    const representative = snapped[0];
    if (!representative) continue;
    // An icon's top edge and a text line box's top edge are not a claim about
    // anything: only primitives of one kind share a block EDGE. The centres are
    // exactly where a cross-kind comparison is meaningful, so they stay mixed.
    if (representative.anchor === 'block-start' || representative.anchor === 'block-end') {
      const kinds = new Set(snapped.map((member) => member.kind ?? ''));
      if (kinds.size > 1) continue;
    }
    // A Y rail claims that these primitives sit on ONE line, so a primitive
    // that neither reaches that line nor sits within half a row of it is not on
    // it: it is content of another line that the row snapshot happened to
    // include, and calling the distance between them a misalignment would be
    // false. Both tests are needed. Ink alone is too strict — an ellipsis glyph
    // is barely a pixel tall, so any offset at all would drop it instead of
    // reporting it. The row band alone is too loose — a tall field would swallow
    // a label a line above it. The line is then recomputed from what is left.
    const reachesLine = (
      members: readonly BlockRailCandidate[],
      line: number
    ): readonly BlockRailCandidate[] => {
      const heights = members
        .map((member) => member.yEnd - member.yStart)
        .filter((height) => Number.isFinite(height) && height > 0);
      const band = (heights.length > 0 ? median(heights) : 0) / 2 + inlierTolerance;
      return members.filter(
        (member) =>
          (member.yStart - inlierTolerance <= line && line <= member.yEnd + inlierTolerance) ||
          Math.abs(member.coordinate - line) <= band
      );
    };
    const online = reachesLine(snapped, median(snapped.map((member) => member.coordinate)));
    if (online.length < minMembers) continue;
    const line = median(online.map((member) => member.coordinate));
    if (reachesLine(online, line).length < minMembers) continue;
    const members = online
      .map((member) => {
        const delta = Math.abs(member.coordinate - line);
        return { ...member, delta, outlier: delta > inlierTolerance };
      })
      .sort(
        (first, second) =>
          first.xStart - second.xStart ||
          first.coordinate - second.coordinate ||
          first.elementId.localeCompare(second.elementId)
      );
    const coordinates = members.map((member) => member.coordinate);
    rails.push({
      rowId: representative.rowId,
      ...(representative.rowFamily ? { rowFamily: representative.rowFamily } : {}),
      ...(representative.sectionId ? { sectionId: representative.sectionId } : {}),
      evidence: 'row-instance',
      anchor: representative.anchor,
      line,
      spread: Math.max(...coordinates) - Math.min(...coordinates),
      support: members.filter((member) => !member.outlier).length,
      sampleSize: members.length,
      horizontalSpan:
        Math.max(...members.map((member) => member.xEnd)) -
        Math.min(...members.map((member) => member.xStart)),
      members,
      outliers: members.filter(
        (member): member is BlockRailCandidate & { delta: number; outlier: true } => member.outlier
      ),
    });
  }
  return rails;
}

/**
 * The rails a geometric row still owes an explanation for: primitives on one
 * visual line that NO DOM row put there, so nothing but the rendering says they
 * belong together.
 *
 * Same claim, weaker evidence, so the bar is higher and explicit: three members
 * at least, drawn from two or more distinct (row family, scope) pairs — one
 * repeated row shape is the row-instance rule's business — at `visual-center`
 * only, the one anchor a glyph and a mark are comparable at all. The line is the
 * member median on the same DPR grid, and two members at least have to reach it:
 * three coordinates that all disagree have a median but not a line.
 */
function discoverCrossFamilyRails(
  candidates: readonly BlockRailCandidate[],
  rowOfElement: ReadonlyMap<string, number>,
  options: Readonly<{ inlierTolerance: number; minMembers: number; deviceScaleFactor: number }>
): DiscoveredBlockRail[] {
  const { inlierTolerance, minMembers, deviceScaleFactor } = options;
  const byRow = new Map<number, BlockRailCandidate[]>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.anchor !== 'visual-center') continue;
    if (seen.has(candidate.elementId)) continue;
    const row = rowOfElement.get(candidate.elementId);
    if (row === undefined) continue;
    seen.add(candidate.elementId);
    byRow.set(row, [
      ...(byRow.get(row) ?? []),
      {
        ...candidate,
        coordinate: quantizeGeometryCoordinate(candidate.coordinate, deviceScaleFactor),
      },
    ]);
  }

  const rails: DiscoveredBlockRail[] = [];
  const orderedRows = [...byRow.entries()].sort(([first], [second]) => first - second);
  for (const [row, rowCandidates] of orderedRows) {
    if (rowCandidates.length < minMembers) continue;
    const groups = new Set(
      rowCandidates.map((member) => `${member.rowFamily ?? ''}\u0000${member.scope ?? ''}`)
    );
    if (groups.size < 2) continue;
    const line = median(rowCandidates.map((member) => member.coordinate));
    const members = rowCandidates
      .map((member) => {
        const delta = Math.abs(member.coordinate - line);
        return { ...member, delta, outlier: delta > inlierTolerance };
      })
      .sort(
        (first, second) =>
          first.xStart - second.xStart ||
          first.coordinate - second.coordinate ||
          first.elementId.localeCompare(second.elementId)
      );
    const support = members.filter((member) => !member.outlier).length;
    if (support < 2) continue;
    const coordinates = members.map((member) => member.coordinate);
    rails.push({
      rowId: `geometric-row:${row}`,
      evidence: 'cross-family',
      anchor: 'visual-center',
      line,
      spread: Math.max(...coordinates) - Math.min(...coordinates),
      support,
      sampleSize: members.length,
      horizontalSpan:
        Math.max(...members.map((member) => member.xEnd)) -
        Math.min(...members.map((member) => member.xStart)),
      members,
      outliers: members.filter(
        (member): member is BlockRailCandidate & { delta: number; outlier: true } => member.outlier
      ),
    });
  }
  return rails;
}

/**
 * Discover vertical rails WITHOUT reading a single alignment marker.
 *
 * A Y rail's row is GEOMETRIC: the visual line a reader sees, made of every
 * candidate whose vertical extent overlaps that line's median band by half. The
 * DOM row is a PRIOR, never an eligibility test — before this, a control that
 * rendered outside the DOM row of the things it lines up with could not be
 * compared to them at all, and every cross-structural misalignment was invisible
 * by construction rather than by measurement.
 *
 * What the DOM decides is how much evidence a rail needs:
 *
 * - Members of ONE DOM row instance keep the row-instance rule exactly: two
 *   members, any anchor, one capture, the verdict anchor chosen from what the
 *   row is made of.
 * - What is left on a geometric row — elements no row-instance rail measures —
 *   is a `cross-family` rail: three members from two or more (row family, scope)
 *   pairs, `visual-center` only.
 *
 * ONE element, ONE rail, and the DOM prior WINS: an element a row-instance rail
 * already measures never joins a cross-family one, so the rails that exist today
 * are exactly the rails that existed before, with the same members and the same
 * lines. Every anchor is still discovered independently, so a row can report
 * that its boxes agree (`block-center`) while the ink a reader sees does not
 * (`visual-center`). Cross-capture aggregation belongs to finding identity, not
 * to discovery.
 */
export function discoverBlockAlignmentRails(
  candidates: readonly BlockRailCandidate[],
  options: BlockRailDiscoveryOptions = {}
): readonly DiscoveredBlockRail[] {
  const inlierTolerance = options.inlierTolerance ?? 0.5;
  const minMembers = options.minMembers ?? 2;
  const crossFamilyMinMembers = options.crossFamilyMinMembers ?? 3;
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  if (!Number.isFinite(inlierTolerance) || inlierTolerance < 0) {
    throw new RangeError('inlierTolerance must be a finite, non-negative number');
  }
  if (!Number.isInteger(minMembers) || minMembers < 2) {
    throw new RangeError('minMembers must be an integer greater than one');
  }
  if (!Number.isInteger(crossFamilyMinMembers) || crossFamilyMinMembers <= minMembers) {
    throw new RangeError('crossFamilyMinMembers must be an integer above minMembers');
  }
  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.coordinate) ||
      !Number.isFinite(candidate.xStart) ||
      !Number.isFinite(candidate.xEnd) ||
      candidate.xEnd < candidate.xStart
    ) {
      throw new RangeError(`${candidate.elementId}.${candidate.anchor} has invalid geometry`);
    }
  }

  const rowInstanceRails = discoverRowInstanceRails(candidates, {
    inlierTolerance,
    minMembers,
    deviceScaleFactor,
  });
  // Geometric rows are formed over EVERY element, claimed or not: a row's median
  // band is a fact about what is rendered on that line, and computing it from
  // the leftovers alone would let the elements a row rail already explains
  // change where the remaining ones are judged to sit.
  const extentByElement = new Map<string, GeometricRowExtent>();
  for (const candidate of candidates) {
    if (extentByElement.has(candidate.elementId)) continue;
    extentByElement.set(candidate.elementId, {
      id: candidate.elementId,
      yStart: candidate.yStart,
      yEnd: candidate.yEnd,
    });
  }
  const extents = [...extentByElement.values()];
  const assignment = assignGeometricRows(extents);
  const rowOfElement = new Map<string, number>();
  for (const [index, extent] of extents.entries()) {
    const row = assignment[index];
    if (row !== undefined && row >= 0) rowOfElement.set(extent.id, row);
  }
  const claimed = new Set(
    rowInstanceRails.flatMap((rail) => rail.members.map((member) => member.elementId))
  );
  const crossFamilyRails = discoverCrossFamilyRails(
    candidates.filter((candidate) => !claimed.has(candidate.elementId)),
    rowOfElement,
    { inlierTolerance, minMembers: crossFamilyMinMembers, deviceScaleFactor }
  );

  return [...rowInstanceRails, ...crossFamilyRails].sort(
    (first, second) =>
      first.line - second.line ||
      first.rowId.localeCompare(second.rowId) ||
      first.anchor.localeCompare(second.anchor)
  );
}

/** Group start/center/end rails that describe the same repeated visual slot. */
export function groupAlignmentRailFamilies(
  rails: readonly DiscoveredAlignmentRail[]
): readonly AlignmentRailFamily[] {
  const memberKeys = (rail: DiscoveredAlignmentRail) =>
    new Set(rail.members.map((member) => `${member.rowId}\u0000${member.elementId}`));
  const overlap = (leftRail: DiscoveredAlignmentRail, rightRail: DiscoveredAlignmentRail) => {
    const leftKeys = memberKeys(leftRail);
    const rightKeys = memberKeys(rightRail);
    const shared = [...leftKeys].filter((key) => rightKeys.has(key)).length;
    return shared / Math.min(leftKeys.size, rightKeys.size);
  };

  const families: AlignmentRailFamily[] = [];
  for (const rail of rails) {
    const family = families.find(
      (candidateFamily) =>
        candidateFamily.rails.every(
          (candidate) => (candidate.space ?? 'layout-box') === (rail.space ?? 'layout-box')
        ) &&
        !candidateFamily.rails.some((candidate) => candidate.anchor === rail.anchor) &&
        candidateFamily.rails.some((candidate) => overlap(candidate, rail) >= 0.75)
    );
    if (family) {
      const index = families.indexOf(family);
      families[index] = { rails: [...family.rails, rail] };
    } else {
      families.push({ rails: [rail] });
    }
  }
  return families;
}

function selectPreferredAlignmentRailAnchor(
  observations: readonly Readonly<{ family: AlignmentRailFamily; scope: GeometryRect }>[]
): AlignmentRailCandidateAnchor {
  const kinds = observations.flatMap(({ family }) => {
    const representative =
      family.rails.find((rail) => rail.anchor === 'inline-center') ?? family.rails[0];
    return representative?.members.map((member) => member.kind) ?? [];
  });
  const textShare = kinds.filter((kind) => kind === 'text').length / Math.max(1, kinds.length);
  const numericTextShare =
    kinds.filter((kind) => kind === 'numeric-text').length / Math.max(1, kinds.length);
  const normalizedLines = (anchor: AlignmentRailCandidateAnchor) =>
    observations.flatMap(({ family, scope }) => {
      const rail = family.rails.find((candidate) => candidate.anchor === anchor);
      return rail ? [(rail.line - scope.x) / scope.width] : [];
    });
  const starts = normalizedLines('inline-start');
  const ends = normalizedLines('inline-end');
  if (numericTextShare >= 0.5 && ends.length > 0) return 'inline-end';
  if (textShare >= 0.5 && starts.length > 0) return 'inline-start';
  if (ends.length > 0 && median(ends) >= 0.72) return 'inline-end';
  if (starts.length > 0 && median(starts) <= 0.28) return 'inline-start';
  return 'inline-center';
}

/**
 * Collapse start/center/end rails produced by the same repeated visual slot.
 * This per-capture view is for diagnostics. Contract inference consumes the
 * raw families and makes the same anchor decision across all captures.
 */
export function selectCanonicalAlignmentRails(
  rails: readonly DiscoveredAlignmentRail[],
  scope: GeometryRect
): readonly DiscoveredAlignmentRail[] {
  if (!Number.isFinite(scope.x) || !Number.isFinite(scope.width) || scope.width <= 0) {
    throw new RangeError('Canonical rail selection requires a positive finite scope width');
  }

  return groupAlignmentRailFamilies(rails)
    .map((family) => {
      const preferredAnchor = selectPreferredAlignmentRailAnchor([{ family, scope }]);
      return (
        family.rails.find((rail) => rail.anchor === preferredAnchor) ??
        [...family.rails].sort(
          (leftRail, rightRail) =>
            rightRail.confidence - leftRail.confidence || rightRail.support - leftRail.support
        )[0]
      );
    })
    .filter((rail): rail is DiscoveredAlignmentRail => rail !== undefined)
    .sort(
      (first, second) =>
        second.confidence - first.confidence ||
        second.support - first.support ||
        first.line - second.line ||
        first.anchor.localeCompare(second.anchor)
    );
}

/**
 * Infer cross-capture alignment proposals from normalized rail positions. The
 * result carries evidence but no enforcement policy; a later contract compiler
 * must bind a proposal to stable semantic members before CI may enforce it.
 */
export function inferAlignmentRailContractProposals(
  captures: readonly AlignmentRailCapture[],
  options: AlignmentRailContractInferenceOptions = {}
): readonly AlignmentRailContractProposal[] {
  const minCaptures = options.minCaptures ?? 2;
  const mergeTolerance = options.mergeTolerance ?? 0.01;
  const maxPixelMergeTolerance = options.maxPixelMergeTolerance ?? 4;
  const minConfidence = options.minConfidence ?? 0.7;
  if (!Number.isInteger(minCaptures) || minCaptures < 2) {
    throw new RangeError('minCaptures must be an integer of at least two');
  }
  if (!Number.isFinite(mergeTolerance) || mergeTolerance <= 0 || mergeTolerance > 1) {
    throw new RangeError('mergeTolerance must be greater than zero and at most one');
  }
  if (!Number.isFinite(maxPixelMergeTolerance) || maxPixelMergeTolerance <= 0) {
    throw new RangeError('maxPixelMergeTolerance must be a positive finite number');
  }
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new RangeError('minConfidence must be between zero and one');
  }

  type Observation = Readonly<{
    captureId: string;
    scopeKey: string;
    anchor: AlignmentRailCandidateAnchor;
    normalizedLine: number;
    mergeTolerance: number;
    rail: DiscoveredAlignmentRail;
  }>;
  type FamilyObservation = Readonly<{
    captureId: string;
    scopeKey: string;
    scope: GeometryRect;
    family: AlignmentRailFamily;
    normalizedLine: number;
    mergeTolerance: number;
  }>;

  const clusterByLine = <T extends Readonly<{ normalizedLine: number; mergeTolerance: number }>>(
    observations: readonly T[]
  ): readonly T[][] => {
    const clusters: T[][] = [];
    const ordered = [...observations].sort(
      (first, second) => first.normalizedLine - second.normalizedLine
    );
    for (const observation of ordered) {
      const cluster = clusters.at(-1);
      const clusterStart = cluster?.[0]?.normalizedLine;
      const clusterTolerance = cluster
        ? Math.min(...cluster.map((member) => member.mergeTolerance), observation.mergeTolerance)
        : observation.mergeTolerance;
      if (
        !cluster ||
        clusterStart === undefined ||
        observation.normalizedLine - clusterStart > clusterTolerance
      ) {
        clusters.push([observation]);
      } else {
        cluster.push(observation);
      }
    }
    return clusters;
  };

  const captureIdsByScope = new Map<string, Set<string>>();
  const familyObservationsByScope = new Map<string, FamilyObservation[]>();
  for (const capture of captures) {
    if (!capture.captureId || !capture.scopeKey) {
      throw new RangeError('Alignment rail captures require captureId and scopeKey');
    }
    if (!Number.isFinite(capture.scopeRect.width) || capture.scopeRect.width <= 0) {
      throw new RangeError(`${capture.captureId}.${capture.scopeKey} must have positive width`);
    }
    const scopeCaptures = captureIdsByScope.get(capture.scopeKey) ?? new Set<string>();
    scopeCaptures.add(capture.captureId);
    captureIdsByScope.set(capture.scopeKey, scopeCaptures);
    const effectiveMergeTolerance = Math.min(
      mergeTolerance,
      maxPixelMergeTolerance / capture.scopeRect.width
    );
    const families = capture.railFamilies ?? groupAlignmentRailFamilies(capture.rails);
    for (const family of families) {
      const centerRail = family.rails.find((rail) => rail.anchor === 'inline-center');
      const normalizedLine = centerRail
        ? (centerRail.line - capture.scopeRect.x) / capture.scopeRect.width
        : median(
            family.rails.map((rail) => (rail.line - capture.scopeRect.x) / capture.scopeRect.width)
          );
      if (!Number.isFinite(normalizedLine)) continue;
      const observations = familyObservationsByScope.get(capture.scopeKey) ?? [];
      observations.push({
        captureId: capture.captureId,
        scopeKey: capture.scopeKey,
        scope: capture.scopeRect,
        family,
        normalizedLine,
        mergeTolerance: effectiveMergeTolerance,
      });
      familyObservationsByScope.set(capture.scopeKey, observations);
    }
  }

  const observationsByGroup = new Map<string, Observation[]>();
  for (const familyObservations of familyObservationsByScope.values()) {
    for (const familyCluster of clusterByLine(familyObservations)) {
      const preferredAnchor = selectPreferredAlignmentRailAnchor(
        familyCluster.map(({ family, scope }) => ({ family, scope }))
      );
      for (const observation of familyCluster) {
        const rail = observation.family.rails.find(
          (candidate) => candidate.anchor === preferredAnchor
        );
        if (!rail) continue;
        const normalizedLine = (rail.line - observation.scope.x) / observation.scope.width;
        const groupKey = `${observation.scopeKey}\u0000${preferredAnchor}`;
        const selected = observationsByGroup.get(groupKey) ?? [];
        selected.push({
          captureId: observation.captureId,
          scopeKey: observation.scopeKey,
          anchor: preferredAnchor,
          normalizedLine,
          mergeTolerance: observation.mergeTolerance,
          rail,
        });
        observationsByGroup.set(groupKey, selected);
      }
    }
  }

  const proposals: AlignmentRailContractProposal[] = [];
  for (const observations of observationsByGroup.values()) {
    for (const cluster of clusterByLine(observations)) {
      const initialLine = median(cluster.map((member) => member.normalizedLine));
      const byCapture = new Map<string, Observation>();
      for (const observation of cluster) {
        const existing = byCapture.get(observation.captureId);
        if (
          !existing ||
          Math.abs(observation.normalizedLine - initialLine) <
            Math.abs(existing.normalizedLine - initialLine)
        ) {
          byCapture.set(observation.captureId, observation);
        }
      }
      const evidence = [...byCapture.values()];
      if (evidence.length < minCaptures) continue;
      const first = evidence[0];
      if (!first) continue;
      const normalizedLine = median(evidence.map((member) => member.normalizedLine));
      const maxNormalizedResidual = Math.max(
        ...evidence.map((member) => Math.abs(member.normalizedLine - normalizedLine))
      );
      const scopeCaptureCount = captureIdsByScope.get(first.scopeKey)?.size ?? evidence.length;
      const captureCoverage = evidence.length / scopeCaptureCount;
      const meanRailConfidence =
        evidence.reduce((sum, member) => sum + member.rail.confidence, 0) / evidence.length;
      const normalizedTolerance = Math.min(...evidence.map((member) => member.mergeTolerance));
      const residualConfidence = Math.max(0, 1 - maxNormalizedResidual / normalizedTolerance);
      const confidence = meanRailConfidence * captureCoverage * residualConfidence;
      if (confidence < minConfidence) continue;
      const captureIds = evidence.map((member) => member.captureId).sort();
      const proposalKey = [first.scopeKey, first.anchor, Number(normalizedLine.toFixed(4))].join(
        ':'
      );
      proposals.push({
        id: `alignment-rail:${stableGeometryHash(proposalKey)}`,
        kind: 'alignment-rail',
        scopeKey: first.scopeKey,
        anchor: first.anchor,
        normalizedLine,
        normalizedTolerance,
        confidence,
        policy: 'proposal',
        evidence: {
          captureIds,
          captureCoverage,
          support: evidence.reduce((sum, member) => sum + member.rail.support, 0),
          sampleSize: evidence.reduce((sum, member) => sum + member.rail.sampleSize, 0),
          outlierCount: evidence.reduce((sum, member) => sum + member.rail.outliers.length, 0),
          maxNormalizedResidual,
        },
      });
    }
  }

  return proposals.sort(
    (first, second) =>
      second.confidence - first.confidence ||
      second.evidence.captureIds.length - first.evidence.captureIds.length ||
      first.scopeKey.localeCompare(second.scopeKey) ||
      first.normalizedLine - second.normalizedLine
  );
}

/**
 * Spacing-rhythm coordinates intersecting `[start, end]`. The default origin is zero;
 * overlays may pass the main pane's top edge to make the rhythm pane-relative.
 */
export function calculateSpacingRhythmCoordinates(
  start: number,
  end: number,
  origin = 0,
  spacingStep = CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep
): readonly number[] {
  if (
    ![start, end, origin, spacingStep].every(Number.isFinite) ||
    spacingStep <= 0 ||
    end < start
  ) {
    throw new RangeError(
      'Spacing bounds and origin must be finite, with end >= start and step > 0'
    );
  }

  const firstStep = Math.ceil((start - origin) / spacingStep);
  const count = Math.floor((end - (origin + firstStep * spacingStep)) / spacingStep) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    Number((origin + (firstStep + index) * spacingStep).toFixed(8))
  );
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function addNearViolation(
  violations: GeometryViolation[],
  code: GeometryViolationCode,
  path: string,
  actual: number,
  expected: number,
  tolerance: number
): void {
  const delta = Math.abs(actual - expected);
  if (delta <= tolerance) return;
  violations.push({
    code,
    path,
    actual,
    expected,
    delta,
    message:
      `${path} expected ${formatNumber(expected)}px, received ` +
      `${formatNumber(actual)}px (delta ${formatNumber(delta)}px)`,
  });
}

function addContainmentViolations(
  violations: GeometryViolation[],
  childName: string,
  child: GeometryRect,
  parentName: string,
  parent: GeometryRect,
  tolerance: number
): void {
  const edges = [
    ['left', parent.x - child.x],
    ['top', parent.y - child.y],
    ['right', right(child) - right(parent)],
    ['bottom', bottom(child) - bottom(parent)],
  ] as const;

  for (const [edge, overflow] of edges) {
    if (overflow <= tolerance) continue;
    violations.push({
      code: 'containment',
      path: `${childName}.${edge}`,
      actual: overflow,
      expected: 0,
      delta: overflow,
      message: `${childName}.${edge} overflows ${parentName} by ${formatNumber(overflow)}px`,
    });
  }
}

/**
 * Validate one settled DOM measurement. Callers own DOM lookup and animation/
 * font settling; this pure function owns the numeric assertions and diagnostics.
 */
export function validateChatWorkspaceGeometry(
  snapshot: ChatWorkspaceGeometrySnapshot,
  options: ChatWorkspaceGeometryValidationOptions
): readonly GeometryViolation[] {
  const tolerance = options.tolerance ?? CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a finite, non-negative number');
  }

  const violations: GeometryViolation[] = [];
  const anchors = CHAT_WORKSPACE_GEOMETRY_ANCHORS;
  const required = [
    anchors.workspaceShell,
    anchors.mainPane,
    anchors.chatLanding,
    anchors.greetingRegion,
    anchors.composerBand,
    anchors.conversationColumn,
    ...(options.sidebar === 'expanded' ? [anchors.sidebarSlot, anchors.sidebarCard] : []),
  ] as const;
  const requiredSet = new Set<ChatWorkspaceGeometryAnchor>(required);
  const validRects = new Map<ChatWorkspaceGeometryAnchor, GeometryRect>();

  for (const anchor of required) {
    const rect = snapshot[anchor];
    if (!rect) {
      violations.push({
        code: 'missing-anchor',
        path: anchor,
        message: `${anchor} was not measured`,
      });
    } else if (!isValidRect(rect)) {
      violations.push({
        code: 'invalid-rect',
        path: anchor,
        message: `${anchor} must have finite coordinates and non-negative dimensions`,
      });
    } else {
      validRects.set(anchor, rect);
    }
  }

  const shell = validRects.get(anchors.workspaceShell);
  const mainPane = validRects.get(anchors.mainPane);
  const sidebarSlot = validRects.get(anchors.sidebarSlot);
  const sidebarCard = validRects.get(anchors.sidebarCard);
  const chatLanding = validRects.get(anchors.chatLanding);
  const greeting = validRects.get(anchors.greetingRegion);
  const composerBand = validRects.get(anchors.composerBand);
  const conversationColumn = validRects.get(anchors.conversationColumn);

  if (shell && mainPane) {
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.mainPane}.y`,
      mainPane.y,
      shell.y,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.mainPane}.right`,
      right(mainPane),
      right(shell),
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.mainPane}.height`,
      mainPane.height,
      shell.height,
      tolerance
    );

    if (options.sidebar === 'collapsed') {
      addNearViolation(
        violations,
        'edge-alignment',
        `${anchors.mainPane}.x`,
        mainPane.x,
        shell.x,
        tolerance
      );
    }
  }

  if (options.sidebar === 'expanded' && shell && mainPane && sidebarSlot) {
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarSlot}.x`,
      sidebarSlot.x,
      shell.x,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarSlot}.y`,
      sidebarSlot.y,
      shell.y,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarSlot}.height`,
      sidebarSlot.height,
      shell.height,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.mainPane}.x`,
      mainPane.x,
      right(sidebarSlot),
      tolerance
    );
  }

  if (sidebarSlot && sidebarCard) {
    const inset = CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset;
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarCard}.leftInset`,
      sidebarCard.x - sidebarSlot.x,
      inset.left,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarCard}.topInset`,
      sidebarCard.y - sidebarSlot.y,
      inset.top,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarCard}.rightInset`,
      right(sidebarSlot) - right(sidebarCard),
      inset.right,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.sidebarCard}.bottomInset`,
      bottom(sidebarSlot) - bottom(sidebarCard),
      inset.bottom,
      tolerance
    );

    const sidebar = CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar;
    if (
      sidebarCard.width < sidebar.minWidth - tolerance ||
      sidebarCard.width > sidebar.maxWidth + tolerance
    ) {
      violations.push({
        code: 'width-range',
        path: `${anchors.sidebarCard}.width`,
        actual: sidebarCard.width,
        message:
          `${anchors.sidebarCard}.width must be between ${sidebar.minWidth}px and ` +
          `${sidebar.maxWidth}px; received ${formatNumber(sidebarCard.width)}px`,
      });
    }
  }

  if (mainPane && chatLanding) {
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.chatLanding}.x`,
      chatLanding.x,
      mainPane.x,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.chatLanding}.y`,
      chatLanding.y,
      mainPane.y,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.chatLanding}.width`,
      chatLanding.width,
      mainPane.width,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.chatLanding}.height`,
      chatLanding.height,
      mainPane.height,
      tolerance
    );
  }

  if (chatLanding && greeting && composerBand) {
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.greetingRegion}.x`,
      greeting.x,
      chatLanding.x,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.greetingRegion}.y`,
      greeting.y,
      chatLanding.y,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.greetingRegion}.width`,
      greeting.width,
      chatLanding.width,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.composerBand}.x`,
      composerBand.x,
      chatLanding.x,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.composerBand}.width`,
      composerBand.width,
      chatLanding.width,
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.composerBand}.bottom`,
      bottom(composerBand),
      bottom(chatLanding),
      tolerance
    );
    addNearViolation(
      violations,
      'edge-alignment',
      `${anchors.greetingRegion}.bottom`,
      bottom(greeting),
      composerBand.y,
      tolerance
    );
  }

  if (composerBand && conversationColumn) {
    addContainmentViolations(
      violations,
      anchors.conversationColumn,
      conversationColumn,
      anchors.composerBand,
      composerBand,
      tolerance
    );
    addNearViolation(
      violations,
      'horizontal-centering',
      `${anchors.conversationColumn}.centerX`,
      centerX(conversationColumn),
      centerX(composerBand),
      tolerance
    );
    addNearViolation(
      violations,
      'expected-width',
      `${anchors.conversationColumn}.width`,
      conversationColumn.width,
      Math.min(CHAT_WORKSPACE_GEOMETRY_SPEC.conversation.maxOuterWidth, composerBand.width),
      tolerance
    );
  }

  if (mainPane) {
    let grid: CalculatedMainPaneGrid | undefined;
    try {
      grid = calculateMainPaneGrid(mainPane);
    } catch (error) {
      violations.push({
        code: 'width-range',
        path: `${anchors.mainPane}.width`,
        actual: mainPane.width,
        message: error instanceof Error ? error.message : 'Main pane cannot contain its grid',
      });
    }

    for (const placement of options.gridPlacements ?? []) {
      if (!grid) break;
      const rect = snapshot[placement.anchor];
      if (!rect) {
        if (!requiredSet.has(placement.anchor)) {
          violations.push({
            code: 'missing-anchor',
            path: placement.anchor,
            message: `${placement.anchor} was not measured for its grid placement`,
          });
        }
        continue;
      }
      if (!isValidRect(rect)) {
        if (!requiredSet.has(placement.anchor)) {
          violations.push({
            code: 'invalid-rect',
            path: placement.anchor,
            message: `${placement.anchor} must have finite coordinates and non-negative dimensions`,
          });
        }
        continue;
      }

      const expected = calculateGridPlacementRect(grid, placement.start, placement.span);
      addNearViolation(
        violations,
        'grid-placement',
        `${placement.anchor}.gridStart`,
        rect.x,
        expected.x,
        tolerance
      );
      addNearViolation(
        violations,
        'grid-placement',
        `${placement.anchor}.gridWidth`,
        rect.width,
        expected.width,
        tolerance
      );
    }
  }

  for (const measurement of options.spacingMeasurements ?? []) {
    if (
      isSpacingRhythmMultiple(
        measurement.value,
        CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep,
        tolerance
      )
    ) {
      continue;
    }
    violations.push({
      code: 'spacing-rhythm',
      path: measurement.name,
      actual: measurement.value,
      message:
        `${measurement.name} spacing must be a multiple of ` +
        `${CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep}px; received ` +
        `${formatNumber(measurement.value)}px`,
    });
  }

  return violations;
}
