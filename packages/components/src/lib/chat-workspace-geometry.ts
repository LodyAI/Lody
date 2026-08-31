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
  member: 'data-geometry-baseline-member',
} as const;

/** DOM declarations consumed by semantic-alignment measurement. */
export const CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES = {
  x: 'data-geometry-align-x',
  y: 'data-geometry-align-y',
  instance: 'data-geometry-align-instance',
  member: 'data-geometry-align-member',
} as const;

export type SemanticAlignmentAnchor =
  | 'inline-start'
  | 'inline-center'
  | 'inline-end'
  | 'block-start'
  | 'block-center'
  | 'block-end'
  | 'text-baseline';

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

export type SemanticBaselineMemberMeasurement = Readonly<{
  name: string;
  coordinate: number;
}>;

export type SemanticBaselineGroupMeasurement = Readonly<{
  name: string;
  mode: SemanticBaselineMode;
  members: readonly SemanticBaselineMemberMeasurement[];
}>;

export type SemanticBaselineGroupResult = Readonly<{
  name: string;
  mode: SemanticBaselineMode;
  line: number;
  aligned: boolean;
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
  spread: number;
  members: readonly Readonly<SemanticBaselineMemberMeasurement & { delta: number }>[];
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
 * Resolve one semantic row against its first member's line. A group with fewer
 * than two measurable members is reported as aligned because it has no
 * cross-element relationship to compare.
 */
export function evaluateSemanticBaselineGroup(
  group: SemanticBaselineGroupMeasurement,
  tolerance: number = CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance
): SemanticBaselineGroupResult {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a finite, non-negative number');
  }
  const first = group.members[0];
  const line = first?.coordinate ?? 0;
  const members = group.members.map((member) => {
    if (!Number.isFinite(member.coordinate)) {
      throw new RangeError(`${group.name}.${member.name} must have a finite coordinate`);
    }
    return { ...member, delta: Math.abs(member.coordinate - line) };
  });
  return {
    name: group.name,
    mode: group.mode,
    line,
    aligned: members.length < 2 || members.every((member) => member.delta <= tolerance),
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
    return member.coordinate;
  });
  const sorted = [...coordinates].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const line =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
  const members = group.members.map((member) => ({
    ...member,
    delta: Math.abs(member.coordinate - line),
  }));
  const spread = sorted.length < 2 ? 0 : (sorted.at(-1) ?? 0) - (sorted[0] ?? 0);
  const measurable = members.length >= group.minMembers;
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
    spread,
    aligned: measurable && spread <= group.tolerance,
    members,
  };
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
