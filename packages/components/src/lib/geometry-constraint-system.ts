import {
  discoverAlignmentRails,
  discoverBlockAlignmentRails,
  groupAlignmentRailFamilies,
  quantizeGeometryCoordinate,
  selectCanonicalAlignmentRails,
  type AlignmentRailCandidate,
  type AlignmentRailFamily,
  type BlockRailCandidate,
  type BlockRailCandidateAnchor,
  type DiscoveredAlignmentRail,
  type DiscoveredBlockRail,
  type GeometryRect,
  type SemanticAlignmentAnchor,
  type SemanticAlignmentAxis,
  type SemanticGeometryStatus,
} from './chat-workspace-geometry';

export type GeometrySurfaceFamily = 'workspace' | 'session' | 'right-sidebar' | string;

export type GeometryStableLocator = Readonly<{
  role: string;
  name?: string;
  landmark?: Readonly<{ role: string; name?: string }>;
  rowName?: string;
  /** DOM-shape identity for an otherwise unnamed repeated row. */
  rowFamily?: string;
  /**
   * Which instance of `rowFamily` inside its own section this element's row is,
   * numbered from rendered order over the whole document. It is what separates
   * three same-shaped singleton rows once a translated accessible name is only
   * a label, and it is deliberately NOT part of the identity of a data-driven
   * repeated row: ten chat rows of one shape are one finding, not ten.
   */
  familyIndex?: number;
  /** Zero-based position among elements with the same role inside that row. */
  roleIndex?: number;
  /**
   * The element's OWN `tag[role]>child,child` signature. Layout wrappers that
   * carry a spacing token have no accessible name and are not a control inside
   * a row, so this is the only ordinary-DOM identity they have.
   */
  selfFamily?: string;
  /**
   * The nearest `data-geometry-discovery-scope` the element sits in. Added to a
   * finding identity only when the name was dropped, so a chat-list row and a
   * project-list row of one DOM family stay two findings.
   */
  section?: string;
  all?: boolean;
}>;

export type GeometryBoxModelContribution = Readonly<{
  padding: number;
  border: number;
  margin: number;
  gap: number;
  /** Space left after declared box-model values, including sibling/content distribution. */
  layout: number;
  /**
   * Half of (line box − cap-height band) for a text primitive measured at its
   * visual centre. It is font metrics, never a declared term and never a
   * defect, so classification must not read it as either.
   */
  typography?: number;
}>;

/** One exact child-to-parent edge in a primitive's rendered ancestor chain. */
export type GeometryBoxModelPathStep = Readonly<{
  nodeId: string;
  element: string;
  /**
   * The node's `class` attribute verbatim, and the nearest function component
   * above it in the React fiber tree. Both are LABELS on a repair ticket, so
   * that an agent handed a finding can open a file instead of hunting a
   * rendered DOM description; neither may ever reach a finding key.
   */
  className?: string;
  component?: string;
  parentId?: string;
  startToParent: number;
  endToParent: number;
  centerToParent: number;
  inlineStart: GeometryBoxModelContribution;
  inlineEnd: GeometryBoxModelContribution;
  /**
   * The same arithmetic on the block axis. Optional because a capture written
   * before Y discovery existed has only the inline terms; an explanation
   * without them simply reports no block path.
   */
  blockStartToParent?: number;
  blockEndToParent?: number;
  blockCenterToParent?: number;
  blockStart?: GeometryBoxModelContribution;
  blockEnd?: GeometryBoxModelContribution;
}>;

/**
 * Display-only naming evidence. None of this is identity: it is exactly the
 * content that must stay out of a finding key, kept so a card can still print
 * a sentence a designer recognises.
 */
export type GeometryCandidateNaming = Readonly<{
  /** Accessible names of the controls nested inside the locator owner. */
  nestedControlNames?: readonly string[];
  /** Longest direct text inside the locator owner, ignoring nested controls. */
  rowTitle?: string;
}>;

export type GeometryCapturedCandidate = AlignmentRailCandidate &
  Readonly<{
    primitiveId: string;
    locator: GeometryStableLocator;
    label: string;
    naming?: GeometryCandidateNaming;
    boxModelNodeRef?: string;
    /** The nearest declared discovery scope, independent of the snapshot scope. */
    sectionScope?: string;
  }>;

/**
 * A Y candidate for one primitive of one visual row. It reuses the row, family,
 * section, locator, label and box-model reference the X candidates already
 * carry, so a Y finding is keyed by exactly the same identity rules.
 */
export type GeometryCapturedBlockCandidate = BlockRailCandidate &
  Readonly<{
    primitiveId: string;
    locator: GeometryStableLocator;
    label: string;
    naming?: GeometryCandidateNaming;
    boxModelNodeRef?: string;
    /** The nearest declared discovery scope, independent of the snapshot scope. */
    sectionScope?: string;
    /**
     * visual centre − box centre for a text primitive: the font-metric term the
     * explanation must name so it is not mistaken for a box-model defect.
     */
    typographyOffset?: number;
  }>;

export type GeometryCapturedScope = Readonly<{
  key: string;
  /** Stable across captures; unlike `key`, this never contains a DOM ordinal. */
  identity: string;
  source: 'hint' | 'auto';
  depth: number;
  rect: GeometryRect;
  candidates: readonly GeometryCapturedCandidate[];
  /** Y candidates for the same primitives; discovery runs per row instance. */
  blockCandidates?: readonly GeometryCapturedBlockCandidate[];
  topology?: Readonly<{
    signature: string;
    instanceCount: number;
    confidence: number;
  }>;
  /** Transient capture helper; persisted artifacts hoist this map to the capture. */
  boxModelNodes?: Readonly<Record<string, GeometryBoxModelPathStep>>;
}>;

export type GeometrySemanticObservation = Readonly<{
  group: string;
  instance: string | null;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  status: SemanticGeometryStatus;
  line: number;
  members: readonly Readonly<{
    name: string;
    locator?: GeometryStableLocator;
    coordinate: number;
    /** `dom-N`, shared with capture, so a marker member IS a discovered one. */
    primitiveId?: string;
    rect?: GeometryRect;
  }>[];
}>;

export type GeometryCapture = Readonly<{
  captureId: string;
  surfaceFamily: GeometrySurfaceFamily;
  surface: string;
  storyId: string;
  viewport: Readonly<{ width: number; height: number }>;
  deviceScaleFactor: number;
  /** Contract dimensions vary one capture family; they do not create ad-hoc stories. */
  dimensions?: Readonly<{ theme?: string; locale?: string; density?: string }>;
  screenshot: string;
  scopes: readonly GeometryCapturedScope[];
  boxModelNodes?: Readonly<Record<string, GeometryBoxModelPathStep>>;
  semanticAlignments?: readonly GeometrySemanticObservation[];
  /**
   * Marker-based baseline rules, in the same shape as the alignment rules, so
   * marker-removal readiness asks one question of every marker rule there is.
   */
  semanticBaselines?: readonly GeometrySemanticObservation[];
}>;

export type GeometryCaptureArtifact = Readonly<{
  version: 1;
  captures: readonly GeometryCapture[];
}>;

export type GeometryObservedScope = Readonly<{
  captureId: string;
  surfaceFamily: GeometrySurfaceFamily;
  scopeKey: string;
  scopeIdentity: string;
  scopeRect: GeometryRect;
  contentHash: string;
  candidateCount: number;
  claimedPrimitiveCount: number;
  rails?: readonly DiscoveredAlignmentRail[];
  railFamilies?: readonly AlignmentRailFamily[];
  observationRef?: Readonly<{ captureId: string; scopeKey: string }>;
}>;

export type GeometryObservationArtifact = Readonly<{
  version: 1;
  captures: readonly Readonly<{
    captureId: string;
    surfaceFamily: GeometrySurfaceFamily;
    scopes: readonly GeometryObservedScope[];
    /**
     * Y rails are per visual row, and one row can be snapshotted by several
     * overlapping scopes, so they are observed once per CAPTURE over the union
     * of every scope's Y candidates rather than once per scope.
     */
    blockRails?: readonly DiscoveredBlockRail[];
  }>[];
}>;

export type GeometryObservationCache = Map<string, GeometryObservedScope>;

export type GeometryFindingEvidence = Readonly<{
  captureId: string;
  scopeKey: string;
  coordinate: number;
  line: number;
  normalizedLine: number;
  offset: number;
  yStart: number;
  yEnd: number;
  /** Y evidence only: the horizontal extent of the member and its row. */
  xStart?: number;
  xEnd?: number;
  rowId?: string;
  explanation?: GeometryOffsetExplanation;
  /** Which anchor the numbers above came from. Y evidence only. */
  anchor?: BlockRailCandidateAnchor;
  /**
   * The SAME element measured at every other anchor its row reported it on.
   * They are supporting measurements, never verdicts: a block edge pair says
   * the primitive is a different height, which is not a misalignment.
   */
  supportingAnchors?: readonly GeometryAnchorMeasurement[];
  /** Every primitive the row placed on this line, at the verdict anchor. */
  rowMembers?: readonly GeometryRowMember[];
}>;

/** One element measured at one anchor, against the row line of that anchor. */
export type GeometryAnchorMeasurement = Readonly<{
  anchor: BlockRailCandidateAnchor;
  coordinate: number;
  line: number;
  offset: number;
  /** Distance between the row's extreme members at this anchor. */
  spread: number;
}>;

/** A row member as a Y card draws it: enough to annotate it, nothing more. */
export type GeometryRowMember = Readonly<{
  label: string;
  primitiveId: string;
  kind?: string;
  coordinate: number;
  offset: number;
  outlier: boolean;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}>;

/** Box-model terms a stylesheet declares, as opposed to the `layout` remainder. */
export type GeometryDeclaredBoxModelTerm = 'padding' | 'border' | 'margin' | 'gap';

export type GeometryRepairTerm = Readonly<{
  /** Which of the two compared primitives carries the larger value. */
  side: 'member' | 'reference';
  term: GeometryDeclaredBoxModelTerm;
  /** Rendered description of the box-model node that owns the differing term. */
  element: string;
  /** That node's `class` attribute and owning component: source pointers, not identity. */
  className?: string;
  component?: string;
  memberElement?: string;
  referenceElement?: string;
  memberValue: number;
  referenceValue: number;
  /** member − reference, in CSS pixels. */
  delta: number;
}>;

export type GeometryRepairProposal = Readonly<{
  commonAncestor: string;
  /** The common ancestor's own source pointers, on the same evidence footing. */
  className?: string;
  component?: string;
  edge: 'inline-start' | 'inline-end' | 'block-start' | 'block-end';
  terms: readonly GeometryRepairTerm[];
  /**
   * Which repair this proposal IS, independent of which element reported it.
   * Findings never merge on it — the key is untouched — but a report folds one
   * card per group, so ten rows sharing one wrong padding read as one ticket.
   */
  repairGroup?: string;
}>;

export type GeometryOffsetExplanation = Readonly<{
  commonAncestor: string;
  reference: Readonly<{ label: string; locator: GeometryStableLocator }>;
  memberPath: Readonly<{
    distance: number;
    contribution: GeometryBoxModelContribution;
  }>;
  referencePath: Readonly<{
    distance: number;
    contribution: GeometryBoxModelContribution;
  }>;
  explainedOffset: number;
  residual: number;
  /** Present only when declared terms actually differ along the two paths. */
  repair?: GeometryRepairProposal;
}>;

/**
 * Deterministic, evidence-only classification of an alignment-rail finding.
 * `css-defect` is repairable by editing a declared box-model term,
 * `optical-residual` is glyph/rounding whitespace inside one device pixel of
 * the measurement model, and `structural` is everything else.
 */
export type GeometryFindingClassification = 'css-defect' | 'optical-residual' | 'structural';

export type GeometryDimensionAxis = 'theme' | 'locale' | 'density';

export const GEOMETRY_DIMENSION_AXES: readonly GeometryDimensionAxis[] = [
  'theme',
  'locale',
  'density',
];

export type GeometryDimensionSensitivity = Readonly<{
  axis: GeometryDimensionAxis;
  value: string;
}>;

/**
 * `row-spread` is what a two-member row can honestly report. With two members
 * the median is their midpoint, so BOTH sit half the gap away from it and
 * blaming either one for `spread / 2` invents a direction the measurement does
 * not contain. Three members or more have a majority, so the median is a line
 * and a member off it is an outlier with a sign.
 */
export type GeometryFindingKind =
  | 'alignment-rail'
  | 'row-spread'
  | 'cross-family'
  | 'measurement-model-divergence';

export type GeometryFinding = Readonly<{
  key: string;
  kind: GeometryFindingKind;
  surfaceFamily: GeometrySurfaceFamily;
  locator?: GeometryStableLocator;
  /** Always human readable: accessible name, else role plus a row description. */
  label: string;
  axis: SemanticAlignmentAxis;
  /**
   * Y: the anchor the verdict came from — `visual-center` when the row mixes
   * text with an icon, image or painted shape, `text-baseline` when every
   * member is text, `block-center` otherwise. X: the rail's own anchor.
   */
  anchor: SemanticAlignmentAnchor;
  /** Why that anchor decided, so a reviewer can check the rule, not guess it. */
  verdictAnchorReason?: 'mixed-kinds' | 'all-text' | 'boxes-only';
  /** `row-spread` only: the distance between the row's extreme members. */
  spread?: number;
  normalizedLine?: number;
  offset: number;
  captureCount: number;
  totalCaptureCount: number;
  /** Alignment-rail findings only; derived from evidence explanations alone. */
  classification?: GeometryFindingClassification;
  repairProposal?: GeometryRepairProposal;
  /**
   * Which REPAIR this finding belongs to, for `css-defect` findings that name
   * one. Grouping only: the key, the evidence and the review are untouched, and
   * a finding without a repair proposal simply has none.
   */
  repairGroup?: string;
  /** Set when every evidence row shares one value of a varying capture axis. */
  dimensionSensitivity?: readonly GeometryDimensionSensitivity[];
  evidence: readonly GeometryFindingEvidence[];
}>;

export type GeometryFindingArtifact = Readonly<{
  version: 1;
  findings: readonly GeometryFinding[];
}>;

/**
 * How a human reviewed one finding.
 *
 * `accepted-debt` used to carry two different decisions under one word — "this
 * is wrong and we will fix it later" and "this is not a defect" — so a queue
 * built from it mixed work with non-work. They are `debt` and `wont-fix` now.
 * `fixed` is the other end of the same flywheel: a finding measured back to
 * zero, re-baselined there, and therefore held to the STRICTEST ratchet of
 * all — reopening it is a regression, not a new review.
 *
 * Only `promoted` compiles into a contract. `new`, `debt`, `wont-fix`, `fixed`
 * and `ignored` compile into nothing; what separates them is the ratchet,
 * which skips `ignored` and holds every other status to its baseline.
 */
export type GeometryLedgerStatus =
  | 'new'
  | 'debt'
  | 'wont-fix'
  | 'fixed'
  | 'ignored'
  | 'promoted';

/** Statuses the ratchet holds to their reviewed baseline. */
export const GEOMETRY_RATCHETED_LEDGER_STATUSES: readonly GeometryLedgerStatus[] = [
  'new',
  'debt',
  'wont-fix',
  'fixed',
];

/**
 * The stylesheet is the single source of truth for a named geometry token. A
 * ledger entry only says WHICH custom property carries it; `expected` is
 * documentation for a human reader and is never used as a gate value.
 */
export type GeometryDesignToken = Readonly<{
  unit: 'px';
  cssVariable: `--${string}`;
  expected?: number;
}>;

export type GeometryResolvedToken = Readonly<{
  name: string;
  cssVariable: string;
  value: number;
}>;

/**
 * Turn the computed value of a token's custom property into a number. A missing
 * or non-px value is a hard error: silently falling back to a checked-in number
 * would make the gate pass against a token the product no longer defines.
 */
export function resolveGeometryDesignToken(
  name: string,
  token: GeometryDesignToken | undefined,
  computedValue: string | null | undefined
): GeometryResolvedToken {
  if (!token) throw new Error(`Geometry token ${name} is not declared in the ledger`);
  const raw = (computedValue ?? '').trim();
  if (raw === '') {
    throw new Error(
      `Geometry token ${name} (${token.cssVariable}) resolved to nothing in the document`
    );
  }
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
  if (!match) {
    throw new Error(
      `Geometry token ${name} (${token.cssVariable}) is not a px length: ${JSON.stringify(raw)}`
    );
  }
  return { name, cssVariable: token.cssVariable, value: Number(match[1]) };
}

export type GeometryBoxModelProperty =
  | 'padding-inline-start'
  | 'padding-inline-end'
  | 'border-inline-start-width'
  | 'border-inline-end-width'
  | 'row-gap'
  | 'column-gap';

export type GeometryContractRelation =
  | Readonly<{ kind: 'coincident' }>
  | Readonly<{
      kind: 'box-model-equals-token' | 'box-model-multiple-of-token';
      property: GeometryBoxModelProperty;
      token: string;
    }>
  | Readonly<{
      /**
       * One rail reached by more than one declared term: the member's value is
       * the sum of these properties. Rows reach the trailing rail as padding
       * plus a transparent border, and a single-property contract would have to
       * exclude them or loosen the tolerance to include them.
       */
      kind: 'box-model-sum-equals-token';
      properties: readonly GeometryBoxModelProperty[];
      token: string;
    }>;

/** The computed properties a relation reads, or null when it compares coordinates. */
export function geometryContractRelationProperties(
  relation: GeometryContractRelation | undefined
): readonly GeometryBoxModelProperty[] | null {
  if (!relation || relation.kind === 'coincident') return null;
  return relation.kind === 'box-model-sum-equals-token' ? relation.properties : [relation.property];
}

export type GeometryContract = Readonly<{
  name: string;
  story: string;
  members: readonly GeometryStableLocator[];
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  space: 'ink' | 'layout-box';
  tolerance: number;
  /** Omitted contracts retain the original coincident-rail behavior. */
  relation?: GeometryContractRelation;
}>;

/**
 * What a ledger entry reviewed, in terms that survive a key change. A finding
 * key is structural, so improving the structure re-keys entries a human already
 * decided about — and a review nobody can carry forward is a review that has to
 * be done again. This is display identity, never key material.
 */
export type GeometryReviewedIdentity = Readonly<{
  label: string;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  surfaceFamily: GeometrySurfaceFamily;
}>;

export type GeometryLedgerEntry = Readonly<{
  status: GeometryLedgerStatus;
  reason?: string;
  baseline?: Readonly<{ offset: number }>;
  contract?: GeometryContract;
  identity?: GeometryReviewedIdentity;
}>;

export type GeometryLedger = Readonly<{
  version: 1;
  tokens?: Readonly<Record<string, GeometryDesignToken>>;
  findings: Readonly<Record<string, GeometryLedgerEntry>>;
}>;

/**
 * One reviewed entry and the finding that replaced it under a new key. `label`
 * is the strong match: two runs that print the same label are the same element.
 * `measurement` is the fallback for the case where a label CANNOT be normalized
 * — a locale switch renames `Machine` to `\u673a\u5668` — where the same axis, the
 * same anchor, the same surface and an offset within a quarter pixel identify it.
 */
export type GeometryRekeyedFinding = Readonly<{
  from: string;
  to: string;
  reason: 'label' | 'measurement';
  label: string;
}>;

export type GeometryFindingDiff = Readonly<{
  current: readonly Readonly<{ finding: GeometryFinding; state: GeometryLedgerStatus }>[];
  new: readonly GeometryFinding[];
  changed: readonly GeometryFinding[];
  resolved: readonly string[];
  /** Reviewed entries whose element is still here under a different key. */
  rekeyed: readonly GeometryRekeyedFinding[];
}>;

export type GeometryContractArtifact = Readonly<{
  version: 1;
  tokens?: Readonly<Record<string, GeometryDesignToken>>;
  contracts: readonly Readonly<GeometryContract & { findingKey: string }>[];
}>;

export type GeometryQualityMetrics = Readonly<{
  labeledFindingCount: number;
  ignoredFindingCount: number;
  discoveryPrecision: number | null;
  interactivePrimitiveCount: number;
  constrainedInteractivePrimitiveCount: number;
  geometryCoverage: number | null;
}>;

export type GeometryContractEvaluation = Readonly<{
  valid: boolean;
  maximumError: number;
}>;

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function relativeCoordinate(value: number, origin: number, deviceScaleFactor: number): number {
  return quantizeGeometryCoordinate(value - origin, deviceScaleFactor);
}

export function geometryScopeContentHash(
  scope: GeometryCapturedScope,
  deviceScaleFactor: number
): string {
  const normalized = scope.candidates
    .map((candidate) => ({
      locator: candidate.locator,
      label: candidate.label,
      ...(candidate.kind ? { kind: candidate.kind } : {}),
      ...(candidate.space ? { space: candidate.space } : {}),
      ...(candidate.rowFamily ? { rowFamily: candidate.rowFamily } : {}),
      ...(candidate.sectionId ? { sectionId: candidate.sectionId } : {}),
      ...(candidate.alignmentMode ? { alignmentMode: candidate.alignmentMode } : {}),
      anchor: candidate.anchor,
      coordinate: relativeCoordinate(candidate.coordinate, scope.rect.x, deviceScaleFactor),
      yStart: relativeCoordinate(candidate.yStart, scope.rect.y, deviceScaleFactor),
      yEnd: relativeCoordinate(candidate.yEnd, scope.rect.y, deviceScaleFactor),
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return stableHash(
    stableJson({
      width: quantizeGeometryCoordinate(scope.rect.width, deviceScaleFactor),
      height: quantizeGeometryCoordinate(scope.rect.height, deviceScaleFactor),
      candidates: normalized,
    })
  );
}

function quantizeCandidate(
  candidate: GeometryCapturedCandidate,
  deviceScaleFactor: number
): GeometryCapturedCandidate {
  return {
    ...candidate,
    coordinate: quantizeGeometryCoordinate(candidate.coordinate, deviceScaleFactor),
    yStart: quantizeGeometryCoordinate(candidate.yStart, deviceScaleFactor),
    yEnd: quantizeGeometryCoordinate(candidate.yEnd, deviceScaleFactor),
  };
}

function scopeArea(scope: GeometryCapturedScope): number {
  return scope.rect.width * scope.rect.height;
}

function rectContains(outer: GeometryRect, inner: GeometryRect): boolean {
  const tolerance = 0.5;
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/**
 * Observation is deliberately deterministic. A child scope turns supported
 * primitive rails into summaries; its parent clusters those summaries together
 * with primitives that no child rail claimed. This preserves cross-partition
 * relationships without letting every ancestor rediscover every raw candidate.
 * Byte-identical scope captures reference the first observation.
 */
export function observeGeometryCaptures(
  artifact: GeometryCaptureArtifact,
  options: Readonly<{ cache?: GeometryObservationCache }> = {}
): GeometryObservationArtifact {
  const canonicalByContent = options.cache ?? new Map<string, GeometryObservedScope>();
  const captures = artifact.captures.map((capture) => {
    const observations: GeometryObservedScope[] = [];
    const processedScopes = new Map<string, GeometryCapturedScope>();
    const scopes = [...capture.scopes].sort(
      (left, right) =>
        scopeArea(left) - scopeArea(right) ||
        right.depth - left.depth ||
        left.identity.localeCompare(right.identity)
    );

    for (const scope of scopes) {
      const contentHash = geometryScopeContentHash(scope, capture.deviceScaleFactor);
      const contained = observations.filter((observation) => {
        const captured = processedScopes.get(observation.scopeKey);
        return (
          captured !== undefined &&
          scopeArea(captured) < scopeArea(scope) &&
          rectContains(scope.rect, captured.rect)
        );
      });
      const children = contained.filter((candidate) => {
        const candidateScope = processedScopes.get(candidate.scopeKey);
        if (!candidateScope) return false;
        return !contained.some((between) => {
          if (between.scopeKey === candidate.scopeKey) return false;
          const betweenScope = processedScopes.get(between.scopeKey);
          return (
            betweenScope !== undefined &&
            scopeArea(candidateScope) < scopeArea(betweenScope) &&
            rectContains(betweenScope.rect, candidateScope.rect)
          );
        });
      });
      const hierarchyHash = stableHash(
        stableJson(
          children
            .map((child) => ({ identity: child.scopeIdentity, contentHash: child.contentHash }))
            .sort((left, right) => left.identity.localeCompare(right.identity))
        )
      );
      const cacheKey = `${capture.surfaceFamily}\u0000${scope.identity}\u0000${contentHash}\u0000${hierarchyHash}`;
      const canonical = canonicalByContent.get(cacheKey);
      if (canonical) {
        observations.push({
          captureId: capture.captureId,
          surfaceFamily: capture.surfaceFamily,
          scopeKey: scope.key,
          scopeIdentity: scope.identity,
          scopeRect: scope.rect,
          contentHash,
          candidateCount: scope.candidates.length,
          claimedPrimitiveCount: canonical.claimedPrimitiveCount,
          observationRef: { captureId: canonical.captureId, scopeKey: canonical.scopeKey },
        });
        processedScopes.set(scope.key, scope);
        continue;
      }

      const knownScopes = [...observations, ...canonicalByContent.values()];
      const childRailCandidates = children.flatMap((child) => {
        const materialized = materializeGeometryObservationScope(child, knownScopes);
        return (materialized.rails ?? []).flatMap((rail) =>
          rail.members.flatMap((member) => {
            const captured = member as typeof member & Partial<GeometryCapturedCandidate>;
            return captured.primitiveId && captured.locator && captured.label
              ? [captured as GeometryCapturedCandidate]
              : [];
          })
        );
      });
      const claimedByChildren = new Set(
        childRailCandidates.map((candidate) => candidate.primitiveId)
      );
      const candidateByIdentity = new Map<string, GeometryCapturedCandidate>();
      for (const candidate of [
        ...scope.candidates.filter((item) => !claimedByChildren.has(item.primitiveId)),
        ...childRailCandidates,
      ]) {
        const quantized = quantizeCandidate(candidate, capture.deviceScaleFactor);
        candidateByIdentity.set(`${quantized.primitiveId}\u0000${quantized.anchor}`, quantized);
      }
      const candidates = [...candidateByIdentity.values()];
      const heights = candidates
        .map((candidate) => candidate.yEnd - candidate.yStart)
        .filter((height) => Number.isFinite(height) && height > 0)
        .sort((left, right) => left - right);
      const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 16;
      const rawRails = discoverAlignmentRails(candidates, {
        mergeTolerance: Math.max(4, Math.min(12, typicalHeight / 2)),
        minSupport: 2,
        scopeHeight: scope.rect.height,
      });
      const rails = selectCanonicalAlignmentRails(rawRails, scope.rect);
      const claimedHere = new Set(
        rails.flatMap((rail) =>
          rail.members
            .map(
              (member) => (member as typeof member & Partial<GeometryCapturedCandidate>).primitiveId
            )
            .filter((primitiveId): primitiveId is string => Boolean(primitiveId))
        )
      );
      const observation: GeometryObservedScope = {
        captureId: capture.captureId,
        surfaceFamily: capture.surfaceFamily,
        scopeKey: scope.key,
        scopeIdentity: scope.identity,
        scopeRect: scope.rect,
        contentHash,
        candidateCount: scope.candidates.length,
        claimedPrimitiveCount: claimedHere.size,
        rails,
        railFamilies: groupAlignmentRailFamilies(rawRails),
      };
      observations.push(observation);
      canonicalByContent.set(cacheKey, observation);
      processedScopes.set(scope.key, scope);
    }

    const blockCandidates = new Map<string, GeometryCapturedBlockCandidate>();
    for (const scope of capture.scopes) {
      for (const candidate of scope.blockCandidates ?? []) {
        // A row can be snapshotted by an aggregate scope and by its child, and
        // the union is what the row actually renders; the first occurrence wins
        // so a scope's iteration order cannot change a median.
        const key = `${candidate.rowId} ${candidate.primitiveId} ${candidate.anchor}`;
        if (!blockCandidates.has(key)) blockCandidates.set(key, candidate);
      }
    }
    const blockRails = discoverBlockAlignmentRails(
      [...blockCandidates.values()].map((candidate) =>
        candidate.scope === undefined && candidate.sectionScope
          ? { ...candidate, scope: candidate.sectionScope }
          : candidate
      ),
      { deviceScaleFactor: capture.deviceScaleFactor }
    );

    return {
      captureId: capture.captureId,
      surfaceFamily: capture.surfaceFamily,
      scopes: observations.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)),
      ...(blockRails.length > 0 ? { blockRails } : {}),
    };
  });
  return { version: 1, captures };
}

/**
 * Identity is STRUCTURAL: landmark, section, row family, role, which instance
 * of that family in the section, and which element of that role in the row. An
 * accessible name never appears here — `Machine` and `\u673a\u5668` are one control, and a
 * finding that changed key because the fixture switched locale is a finding
 * nobody can review twice.
 */
function locatorIdentity(locator: GeometryStableLocator): string {
  const landmark = locator.landmark
    ? `${locator.landmark.role}:${locator.landmark.name ?? ''}>`
    : '';
  const section = locator.section ? `section:${locator.section}>` : '';
  const row = locator.rowName ? `row:${locator.rowName}>` : '';
  const rowFamily = locator.rowFamily ? `row-family:${locator.rowFamily}>` : '';
  const familyIndex = locator.familyIndex === undefined ? '' : `@${locator.familyIndex}`;
  const roleIndex = locator.roleIndex === undefined ? '' : `#${locator.roleIndex}`;
  return `${landmark}${section}${row}${rowFamily}${locator.role}${familyIndex}${roleIndex}`;
}

function makeFindingKey(parts: readonly string[]): string {
  const identity = parts.join('|');
  return `geometry/${parts[0]}/${stableHash(identity)}`;
}

/**
 * A Y finding is ONE ELEMENT in one row, not one element per anchor: the same
 * icon reported at `block-start`, `block-center`, `visual-center` and
 * `text-baseline` is four measurements of a single question, so the key carries
 * the axis and the finding names the anchor its verdict came from. X anchors
 * stay in the key — `inline-start` and `inline-end` really are two rails.
 */
export function alignmentFindingKey(
  input: Readonly<{
    surfaceFamily: GeometrySurfaceFamily;
    locator: GeometryStableLocator;
    anchor: GeometryExplainedAnchor;
    axis?: SemanticAlignmentAxis;
    /**
     * A two-member row is one spread, keyed by the row rather than a member; a
     * `cross-family` outlier is the same element a row Y finding would name, so
     * the kind is what keeps the two questions apart. No coordinate, scope name
     * or accessible name ever enters here.
     */
    kind?: GeometryFindingKind;
  }>
): string {
  const axisTerm = input.axis === 'y' ? 'y' : input.anchor;
  return makeFindingKey([
    input.surfaceFamily,
    locatorIdentity(input.locator),
    axisTerm,
    ...(input.kind === 'row-spread' ? ['row-spread'] : []),
    ...(input.kind === 'cross-family' ? ['cross-family'] : []),
  ]);
}

function resolveObservedScope(
  scope: GeometryObservedScope,
  byCaptureAndScope: ReadonlyMap<string, GeometryObservedScope>
): GeometryObservedScope {
  let current = scope;
  const visited = new Set<string>();
  while (current.observationRef) {
    const key = `${current.observationRef.captureId}\u0000${current.observationRef.scopeKey}`;
    if (visited.has(key)) throw new Error(`Circular geometry observation reference: ${key}`);
    visited.add(key);
    const referenced = byCaptureAndScope.get(key);
    if (!referenced) throw new Error(`Missing geometry observation reference: ${key}`);
    current = referenced;
  }
  return current;
}

export function materializeGeometryObservationScope(
  scope: GeometryObservedScope,
  scopes: readonly GeometryObservedScope[]
): GeometryObservedScope {
  const byCaptureAndScope = new Map(
    scopes.map((candidate) => [`${candidate.captureId}\u0000${candidate.scopeKey}`, candidate])
  );
  const source = resolveObservedScope(scope, byCaptureAndScope);
  if (source === scope) return scope;
  const deltaX = scope.scopeRect.x - source.scopeRect.x;
  const deltaY = scope.scopeRect.y - source.scopeRect.y;
  const translateRail = (rail: DiscoveredAlignmentRail): DiscoveredAlignmentRail => {
    const members = rail.members.map((member) => ({
      ...member,
      coordinate: member.coordinate + deltaX,
      yStart: member.yStart + deltaY,
      yEnd: member.yEnd + deltaY,
    }));
    return {
      ...rail,
      line: rail.line + deltaX,
      members,
      outliers: members.filter(
        (member): member is (typeof members)[number] & { outlier: true } => member.outlier
      ),
    };
  };
  const rails = (source.rails ?? []).map(translateRail);
  return {
    ...scope,
    rails,
    railFamilies: groupAlignmentRailFamilies(rails),
  };
}

function roundedNormalizedLine(line: number, rect: GeometryRect): number {
  if (rect.width <= 0) return 0;
  return Number(((line - rect.x) / rect.width).toFixed(4));
}

const EMPTY_BOX_MODEL_CONTRIBUTION: GeometryBoxModelContribution = {
  padding: 0,
  border: 0,
  margin: 0,
  gap: 0,
  layout: 0,
};

function addBoxModelContribution(
  left: GeometryBoxModelContribution,
  right: GeometryBoxModelContribution
): GeometryBoxModelContribution {
  return {
    padding: left.padding + right.padding,
    border: left.border + right.border,
    margin: left.margin + right.margin,
    gap: left.gap + right.gap,
    layout: left.layout + right.layout,
  };
}

/** Every anchor an offset explanation can be asked about, on either axis. */
export type GeometryExplainedAnchor =
  | 'inline-start'
  | 'inline-center'
  | 'inline-end'
  | BlockRailCandidateAnchor;

const BLOCK_EDGE_ANCHORS: ReadonlySet<GeometryExplainedAnchor> = new Set([
  'block-start',
  'block-end',
]);

function isBlockAnchor(anchor: GeometryExplainedAnchor): boolean {
  return anchor !== 'inline-start' && anchor !== 'inline-center' && anchor !== 'inline-end';
}

function summarizeBoxModelPath(
  path: readonly GeometryBoxModelPathStep[],
  commonAncestorId: string,
  anchor: GeometryExplainedAnchor
): Readonly<{ distance: number; contribution: GeometryBoxModelContribution }> {
  let distance = 0;
  let contribution = EMPTY_BOX_MODEL_CONTRIBUTION;
  for (const step of path) {
    if (step.nodeId === commonAncestorId) break;
    if (anchor === 'inline-start') {
      distance += step.startToParent;
      contribution = addBoxModelContribution(contribution, step.inlineStart);
    } else if (anchor === 'inline-end') {
      distance += step.endToParent;
      contribution = addBoxModelContribution(contribution, step.inlineEnd);
    } else if (anchor === 'inline-center') {
      distance += step.centerToParent;
      contribution = addBoxModelContribution(contribution, {
        ...EMPTY_BOX_MODEL_CONTRIBUTION,
        layout: step.centerToParent,
      });
    } else if (anchor === 'block-start') {
      distance += step.blockStartToParent ?? 0;
      contribution = addBoxModelContribution(
        contribution,
        step.blockStart ?? EMPTY_BOX_MODEL_CONTRIBUTION
      );
    } else if (anchor === 'block-end') {
      distance += step.blockEndToParent ?? 0;
      contribution = addBoxModelContribution(
        contribution,
        step.blockEnd ?? EMPTY_BOX_MODEL_CONTRIBUTION
      );
    } else {
      // A block centre, a visual centre and a baseline all travel the same
      // distance through the box model; what separates them is the per-member
      // typography term the caller adds, never a declared box-model property.
      const centerToParent = step.blockCenterToParent ?? 0;
      distance += centerToParent;
      contribution = addBoxModelContribution(contribution, {
        ...EMPTY_BOX_MODEL_CONTRIBUTION,
        layout: centerToParent,
      });
    }
  }
  return { distance, contribution };
}

/** Explain an observed delta using exact ancestor distances plus declared CSS terms. */
export function explainGeometryOffset(
  member: GeometryCapturedCandidate | GeometryCapturedBlockCandidate,
  reference: GeometryCapturedCandidate | GeometryCapturedBlockCandidate,
  anchor: GeometryExplainedAnchor,
  observedOffset: number,
  nodes: Readonly<Record<string, GeometryBoxModelPathStep>> = {}
): GeometryOffsetExplanation | undefined {
  const materializePath = (nodeRef: string | undefined) => {
    const path: GeometryBoxModelPathStep[] = [];
    const visited = new Set<string>();
    for (let nodeId = nodeRef; nodeId && !visited.has(nodeId); ) {
      visited.add(nodeId);
      const node = nodes[nodeId];
      if (!node) break;
      path.push(node);
      nodeId = node.parentId;
    }
    return path;
  };
  const memberPathSteps = materializePath(member.boxModelNodeRef);
  const referencePathSteps = materializePath(reference.boxModelNodeRef);
  if (!memberPathSteps?.length || !referencePathSteps?.length) return undefined;
  const referenceNodeIds = new Set(referencePathSteps.map((step) => step.nodeId));
  const commonAncestor = memberPathSteps.find((step) => referenceNodeIds.has(step.nodeId));
  if (!commonAncestor) return undefined;
  if (isBlockAnchor(anchor) && memberPathSteps[0]?.blockStartToParent === undefined) {
    return undefined;
  }
  const rawMemberPath = summarizeBoxModelPath(memberPathSteps, commonAncestor.nodeId, anchor);
  const rawReferencePath = summarizeBoxModelPath(referencePathSteps, commonAncestor.nodeId, anchor);
  // Half of (line box − cap-height band) is why a centred label's ink sits off
  // its own box centre. It is recorded as its own term, so an explanation can
  // say "font metrics" instead of leaving it inside an unexplained residual.
  const typography = (candidate: typeof member) =>
    anchor === 'visual-center' && 'typographyOffset' in candidate
      ? (candidate.typographyOffset ?? 0)
      : 0;
  const memberTypography = typography(member);
  const referenceTypography = typography(reference);
  const withTypography = (path: typeof rawMemberPath, value: number): typeof rawMemberPath =>
    value === 0
      ? path
      : {
          distance: path.distance + value,
          contribution: { ...path.contribution, typography: value },
        };
  const memberPath = withTypography(rawMemberPath, memberTypography);
  const referencePath = withTypography(rawReferencePath, referenceTypography);
  const explainedOffset =
    anchor === 'inline-end' || anchor === 'block-end'
      ? referencePath.distance - memberPath.distance
      : memberPath.distance - referencePath.distance;
  const repair = proposeBoxModelRepair(memberPathSteps, referencePathSteps, commonAncestor, anchor);
  return {
    commonAncestor: commonAncestor.element,
    reference: { label: reference.label, locator: reference.locator },
    memberPath,
    referencePath,
    explainedOffset,
    residual: observedOffset - explainedOffset,
    ...(repair ? { repair } : {}),
  };
}

const DECLARED_BOX_MODEL_TERMS: readonly GeometryDeclaredBoxModelTerm[] = [
  'padding',
  'border',
  'margin',
  'gap',
];

/** A term declared on the parent box vs one declared on the node's own box. */
const PARENT_OWNED_TERMS: ReadonlySet<GeometryDeclaredBoxModelTerm> = new Set([
  'padding',
  'border',
  'gap',
]);

/**
 * Walk both ancestor chains up to the common ancestor and diff the declared
 * terms they accumulate. Per-term totals are what the explained offset is made
 * of, so they always add up; each side also names the node that contributes
 * most of its total, which is the node a designer would edit.
 */
function proposeBoxModelRepair(
  memberSteps: readonly GeometryBoxModelPathStep[],
  referenceSteps: readonly GeometryBoxModelPathStep[],
  commonAncestor: GeometryBoxModelPathStep,
  anchor: GeometryExplainedAnchor
): GeometryRepairProposal | undefined {
  // A centre coordinate has no declared term of its own: the box model
  // contributes only through the two edges, so proposing a repair from it
  // would name a property that does not decide the measured coordinate. A
  // baseline and a visual centre are font metrics on top of that centre.
  if (anchor !== 'inline-start' && anchor !== 'inline-end' && !BLOCK_EDGE_ANCHORS.has(anchor)) {
    return undefined;
  }
  const edge = anchor as GeometryRepairProposal['edge'];
  const side =
    anchor === 'inline-start'
      ? 'inlineStart'
      : anchor === 'inline-end'
        ? 'inlineEnd'
        : anchor === 'block-start'
          ? 'blockStart'
          : 'blockEnd';
  const below = (steps: readonly GeometryBoxModelPathStep[]) => {
    const result: GeometryBoxModelPathStep[] = [];
    for (const step of steps) {
      if (step.nodeId === commonAncestor.nodeId) break;
      result.push(step);
    }
    return result.reverse();
  };
  const memberChain = below(memberSteps);
  const referenceChain = below(referenceSteps);
  const terms_ = (step: GeometryBoxModelPathStep) => step[side] ?? EMPTY_BOX_MODEL_CONTRIBUTION;
  const total = (chain: readonly GeometryBoxModelPathStep[], term: GeometryDeclaredBoxModelTerm) =>
    chain.reduce((sum, step) => sum + terms_(step)[term], 0);
  const dominantOwner = (
    chain: readonly GeometryBoxModelPathStep[],
    term: GeometryDeclaredBoxModelTerm
  ): GeometryBoxModelPathStep | undefined => {
    let bestIndex = -1;
    let bestValue = 0;
    chain.forEach((step, index) => {
      const value = Math.abs(terms_(step)[term]);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) return undefined;
    // padding, border and gap are declared on the containing box; margin sits
    // on the node itself.
    return PARENT_OWNED_TERMS.has(term)
      ? (chain[bestIndex - 1] ?? commonAncestor)
      : chain[bestIndex];
  };
  const terms: GeometryRepairTerm[] = [];
  for (const term of DECLARED_BOX_MODEL_TERMS) {
    const memberValue = total(memberChain, term);
    const referenceValue = total(referenceChain, term);
    const delta = memberValue - referenceValue;
    if (Math.abs(delta) < 0.5) continue;
    const memberOwner = dominantOwner(memberChain, term);
    const referenceOwner = dominantOwner(referenceChain, term);
    const dominantSide = Math.abs(memberValue) >= Math.abs(referenceValue) ? 'member' : 'reference';
    const owner =
      (dominantSide === 'member' ? memberOwner : referenceOwner) ??
      memberOwner ??
      referenceOwner ??
      commonAncestor;
    terms.push({
      side: dominantSide,
      term,
      element: owner.element,
      ...(owner.className ? { className: owner.className } : {}),
      ...(owner.component ? { component: owner.component } : {}),
      ...(memberOwner ? { memberElement: memberOwner.element } : {}),
      ...(referenceOwner ? { referenceElement: referenceOwner.element } : {}),
      memberValue: Number(memberValue.toFixed(4)),
      referenceValue: Number(referenceValue.toFixed(4)),
      delta: Number(delta.toFixed(4)),
    });
  }
  if (terms.length === 0) return undefined;
  const sorted = terms.sort(
    (left, right) =>
      Math.abs(right.delta) - Math.abs(left.delta) || left.term.localeCompare(right.term)
  );
  const proposal: GeometryRepairProposal = {
    commonAncestor: commonAncestor.element,
    ...(commonAncestor.className ? { className: commonAncestor.className } : {}),
    ...(commonAncestor.component ? { component: commonAncestor.component } : {}),
    edge,
    terms: sorted,
  };
  return { ...proposal, repairGroup: geometryRepairGroupKey(proposal) };
}

/**
 * Repair identity: WHICH edit closes this, not which element reported it. The
 * component that owns the edit (or, unrendered by React, the common ancestor's
 * DOM description), the term, the edge, and the node the term sits on. It is a
 * grouping label only — findings are never merged on it and no key reads it —
 * so ten rows sharing one wrong padding stay ten reviewed findings and become
 * one ticket.
 */
export function geometryRepairGroupKey(
  proposal: Omit<GeometryRepairProposal, 'repairGroup'>
): string | undefined {
  const dominant = proposal.terms[0];
  if (!dominant) return undefined;
  const owner = dominant.component ?? proposal.component ?? proposal.commonAncestor;
  return makeFindingKey(['repair', owner, dominant.term, proposal.edge, dominant.element]);
}

function declaredTermDelta(explanation: GeometryOffsetExplanation): number {
  return DECLARED_BOX_MODEL_TERMS.reduce(
    (total, term) =>
      total +
      (explanation.memberPath.contribution[term] - explanation.referencePath.contribution[term]),
    0
  );
}

/**
 * The whole classification is arithmetic over one evidence explanation: a
 * declared-term difference the box model fully accounts for is a CSS defect, a
 * difference the box model says is zero but the ink disagrees about by at most
 * 1.5px is optical, and everything else stays a structural review candidate.
 */
export function classifyGeometryOffsetExplanation(
  explanation: GeometryOffsetExplanation | undefined,
  deviceScaleFactor: number
): GeometryFindingClassification {
  if (!explanation) return 'structural';
  const devicePixel = deviceScaleFactor > 0 ? 1 / deviceScaleFactor : 1;
  const explained = Math.abs(explanation.explainedOffset);
  const residual = Math.abs(explanation.residual);
  const declared = Math.abs(declaredTermDelta(explanation));
  const layout = Math.abs(
    explanation.memberPath.contribution.layout - explanation.referencePath.contribution.layout
  );
  if (
    explained >= 1 &&
    residual <= devicePixel &&
    (explanation.repair?.terms.length ?? 0) > 0 &&
    declared > layout
  ) {
    return 'css-defect';
  }
  if (explained < 1 && residual <= 1.5) return 'optical-residual';
  return 'structural';
}

const CLASSIFICATION_SEVERITY: Readonly<Record<GeometryFindingClassification, number>> = {
  'css-defect': 0,
  'optical-residual': 1,
  structural: 2,
};

/** Evidence that disagrees resolves to the most severe class, never an average. */
export function mergeGeometryClassifications(
  classifications: readonly GeometryFindingClassification[]
): GeometryFindingClassification {
  return classifications.reduce<GeometryFindingClassification>(
    (worst, current) =>
      CLASSIFICATION_SEVERITY[current] > CLASSIFICATION_SEVERITY[worst] ? current : worst,
    'css-defect'
  );
}

type RowFamilyToken = Readonly<{ tag: string; role: string }>;

function parseRowFamily(rowFamily: string): Readonly<{
  owner: RowFamilyToken | undefined;
  children: readonly RowFamilyToken[];
}> {
  const token = (raw: string): RowFamilyToken | undefined => {
    const match = /^([a-z0-9-]+)\[([^\]]*)\]$/.exec(raw.trim());
    return match ? { tag: match[1] ?? '', role: match[2] ?? '' } : undefined;
  };
  const [ownerPart, childPart = ''] = rowFamily.split('>');
  return {
    owner: token(ownerPart ?? ''),
    children: childPart
      .split(',')
      .flatMap((part) => (part.trim() ? [token(part)].filter(Boolean) : []))
      .filter((item): item is RowFamilyToken => Boolean(item)),
  };
}

/**
 * A DOM-shape signature is an identity, not a sentence. Findings print this
 * short description instead, so a card never shows the raw family string.
 */
export function describeGeometryRowFamily(rowFamily: string | undefined): string {
  if (!rowFamily) return 'layout';
  const { owner, children } = parseRowFamily(rowFamily);
  const roles = new Set([owner?.role ?? '', ...children.map((child) => child.role)]);
  if (roles.has('tablist') || roles.has('tab')) return 'tab bar';
  if (roles.has('listitem') || owner?.tag === 'li') return 'list row';
  const ownerRole = owner?.role ?? '';
  if (ownerRole === 'button' || ownerRole === 'link') return `${ownerRole} contents`;
  const childRoles = children.map((child) => child.role);
  const hasControl = childRoles.some((role) => role === 'button' || role === 'link');
  const hasText = childRoles.some((role) => role === 'text' || role === 'numeric-text');
  if (hasControl && hasText) return 'row';
  if (hasControl) return 'action row';
  if (hasText) return 'text row';
  return `${owner?.tag ?? 'div'} group`;
}

const HTML_TAG_LABEL = /^[a-z][a-z0-9-]*$/;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * An accessible name accumulates the names of every control nested inside it,
 * so a tab reads as `Files Close Files`. The element's own text is what is left
 * after removing what its nested controls contributed.
 */
export function geometryOwnText(name: string, nestedControlNames: readonly string[] = []): string {
  const full = collapseWhitespace(name);
  let text = full;
  for (const nested of [...nestedControlNames].sort((left, right) => right.length - left.length)) {
    const needle = collapseWhitespace(nested);
    if (needle === '' || needle === text) continue;
    text = collapseWhitespace(text.split(needle).join(' '));
  }
  return text === '' ? full : text;
}

/**
 * True when the accessible name is built from more than the element itself, so
 * it describes the row's current contents rather than the control.
 */
export function isGeometryContentAggregatedName(
  locator: GeometryStableLocator,
  naming: GeometryCandidateNaming | undefined
): boolean {
  if (!locator.name) return false;
  const full = collapseWhitespace(locator.name);
  return geometryOwnText(full, naming?.nestedControlNames ?? []) !== full;
}

/**
 * Identity may never carry content. A control that repeats over data — a row of
 * a repeated row family whose accessible name aggregates that row's own
 * contents — is identified by where it sits (landmark, row family, role,
 * same-role index), so renaming the fixture or switching locale cannot mint a
 * second finding for one element. A singleton keeps its accessible name: it is
 * the only stable thing that separates two controls of the same DOM shape.
 */
const GEOMETRY_DATA_BEARING_NAME_PATTERNS: readonly RegExp[] = [
  // A path segment: a name that quotes where a file or project lives moves the
  // moment the fixture, the machine or the checkout changes.
  /\//,
  // The composed-name separator the product uses to append machine/path facts.
  / \u00b7 /,
  // Relative durations and clock/calendar stamps, which change every render.
  /\d+\s*[smhd]\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}:\d{2}\b/,
];

/**
 * True when an accessible name carries DATA rather than the control's identity:
 * a path, the ` \u00b7 ` separator the product composes facts with, or a
 * timestamp/duration. Such a name is a label — printing it is right, keying a
 * finding by it would mint a new finding on every checkout or every minute.
 */
export function isGeometryDataBearingName(name: string): boolean {
  return GEOMETRY_DATA_BEARING_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Identity is positional, always. The accessible name is dropped from EVERY
 * locator — `Machine` and `\u673a\u5668` are one control, `More actions` and
 * `\u66f4\u591a\u64cd\u4f5c` are one control, and a key that changes with the fixture's
 * locale mints a second finding for an element nobody moved.
 *
 * What is left is landmark, section, row family, role and same-role index, plus
 * ONE more term where those still collide: which instance of the row family in
 * that section this is. That term is added for an ENUMERATED family — a small
 * set of distinct controls sharing one DOM shape, like Settings, Help and
 * Archive — and dropped for a data-driven repeated family, where ten rendered
 * rows of one shape are one reviewable finding rather than ten. A family counts
 * as data-driven when some instance names itself from its own contents or from
 * data, which is exactly what makes its rows interchangeable.
 */
/**
 * One SLOT of one row family inside one section — the unit that either lists or
 * enumerates. A row's leading icon and its trailing button are different
 * questions: three chat rows share one trailing `More actions`, and three
 * footer rows do not share a label at all.
 */
export function geometryRowFamilyKey(
  section: string | undefined,
  rowFamily: string | undefined,
  role: string | undefined,
  roleIndex: number | undefined
): string {
  return `${section ?? ''}\u0000${rowFamily ?? ''}\u0000${role ?? ''}\u0000${roleIndex ?? ''}`;
}

export function geometryIdentityLocator(
  locator: GeometryStableLocator,
  options: Readonly<{
    /** `geometryRowFamilyKey` values whose instances aggregate into one finding. */
    aggregatedRowFamilies?: ReadonlySet<string>;
    /** Nearest declared discovery scope. Element-derived, not scope-derived. */
    section?: string;
  }> = {}
): GeometryStableLocator {
  const { name: _name, familyIndex, ...structural } = locator;
  const sectionName = options.section ?? locator.section;
  const section = sectionName ? { section: sectionName } : {};
  const aggregated =
    options.aggregatedRowFamilies?.has(
      geometryRowFamilyKey(sectionName, locator.rowFamily, locator.role, locator.roleIndex)
    ) ?? false;
  return !aggregated && familyIndex !== undefined
    ? { ...structural, familyIndex, ...section }
    : { ...structural, ...section };
}

/**
 * A row family is repeated when the capture rendered at least two instances of
 * it. Instances are counted by row, not by primitive, so one row's icon and
 * label cannot make a singleton look repeated.
 */
export function collectRepeatedGeometryRowFamilies(
  artifact: GeometryCaptureArtifact
): ReadonlyMap<GeometrySurfaceFamily, ReadonlySet<string>> {
  const repeated = new Map<GeometrySurfaceFamily, Set<string>>();
  for (const capture of artifact.captures) {
    const rowsByFamily = new Map<string, Set<string>>();
    for (const scope of capture.scopes) {
      for (const candidate of [...scope.candidates, ...(scope.blockCandidates ?? [])]) {
        const family = candidate.locator.rowFamily;
        if (!family || !candidate.rowId) continue;
        const rows = rowsByFamily.get(family) ?? new Set<string>();
        rows.add(`${scope.key} ${candidate.rowId}`);
        rowsByFamily.set(family, rows);
      }
    }
    // Union across the captures of one surface: a family repeated in ANY
    // capture is repeated. Overwriting would let the last capture of a surface
    // decide alone, so a story that renders one row would unrepeat a list.
    const families = repeated.get(capture.surfaceFamily) ?? new Set<string>();
    for (const [family, rows] of rowsByFamily) {
      if (rows.size >= 2) families.add(family);
    }
    repeated.set(capture.surfaceFamily, families);
  }
  return repeated;
}

/**
 * How many instances of one row family a section may render before it is a
 * LIST rather than an enumeration, whatever its members are called.
 */
const GEOMETRY_MAX_ENUMERATED_FAMILY_INSTANCES = 3;

/**
 * Which (section, row family, role, same-role index) slots aggregate their
 * instances into a single finding rather than one per rendered instance.
 *
 * The question is whether the instances are INTERCHANGEABLE, and the strongest
 * evidence is what they are called — not the text, which a locale rewrites, but
 * whether they agree. Three chat rows all carry `More actions` in the same
 * slot: one control, seen three times. Three footer rows carry Settings, Help
 * and Archive there: three controls that happen to share a DOM shape, and the
 * family-instance index is the only thing that can tell them apart.
 *
 * Two more signals aggregate on their own, because either alone already means
 * the rows repeat over data: some instance names itself from its own contents
 * or from data (a title, a path, a timestamp), or the section renders more
 * instances than an enumeration would.
 */
export function collectAggregatedGeometryRowFamilies(
  artifact: GeometryCaptureArtifact
): ReadonlyMap<GeometrySurfaceFamily, ReadonlySet<string>> {
  const aggregated = new Map<GeometrySurfaceFamily, Set<string>>();
  for (const capture of artifact.captures) {
    const keys = aggregated.get(capture.surfaceFamily) ?? new Set<string>();
    const families = new Map<
      string,
      {
        section?: string;
        rowFamily: string;
        instances: Set<number>;
        dataDriven: boolean;
        /** slot key -> the names its instances carried, one entry per instance. */
        slots: Map<string, { role: string; roleIndex?: number; names: Map<number, string> }>;
      }
    >();
    for (const scope of capture.scopes) {
      for (const candidate of [...scope.candidates, ...(scope.blockCandidates ?? [])]) {
        const rowFamily = candidate.locator.rowFamily;
        if (!rowFamily) continue;
        const familyKey = `${candidate.sectionScope ?? ''}\u0000${rowFamily}`;
        const family = families.get(familyKey) ?? {
          ...(candidate.sectionScope ? { section: candidate.sectionScope } : {}),
          rowFamily,
          instances: new Set<number>(),
          dataDriven: false,
          slots: new Map<
            string,
            { role: string; roleIndex?: number; names: Map<number, string> }
          >(),
        };
        const name = candidate.locator.name;
        if (
          name !== undefined &&
          (isGeometryDataBearingName(name) ||
            isGeometryContentAggregatedName(candidate.locator, candidate.naming))
        ) {
          family.dataDriven = true;
        }
        const familyIndex = candidate.locator.familyIndex;
        if (familyIndex !== undefined) {
          family.instances.add(familyIndex);
          const slotKey = `${candidate.locator.role}\u0000${candidate.locator.roleIndex ?? ''}`;
          const slot = family.slots.get(slotKey) ?? {
            role: candidate.locator.role,
            ...(candidate.locator.roleIndex === undefined
              ? {}
              : { roleIndex: candidate.locator.roleIndex }),
            names: new Map<number, string>(),
          };
          slot.names.set(familyIndex, name ?? '');
          family.slots.set(slotKey, slot);
        }
        families.set(familyKey, family);
      }
    }
    for (const family of families.values()) {
      const repeatsOverData =
        family.dataDriven || family.instances.size > GEOMETRY_MAX_ENUMERATED_FAMILY_INSTANCES;
      const interchangeable = (slot: { names: Map<number, string> }) =>
        new Set(slot.names.values()).size <= 1;
      for (const slot of family.slots.values()) {
        if (!repeatsOverData && !interchangeable(slot)) continue;
        keys.add(geometryRowFamilyKey(family.section, family.rowFamily, slot.role, slot.roleIndex));
      }
      // The row itself, for a `row-spread` finding: a row aggregates when every
      // one of its slots does, because one distinguishable member is enough to
      // make two rendered rows two different rows.
      if (repeatsOverData || [...family.slots.values()].every((slot) => interchangeable(slot))) {
        keys.add(geometryRowFamilyKey(family.section, family.rowFamily, 'row', undefined));
      }
    }
    aggregated.set(capture.surfaceFamily, keys);
  }
  return aggregated;
}

/**
 * Every finding gets a name a designer can read. A repeated row reads as its
 * role plus the row's own title; a named control reads as its own text without
 * the nested control names its accessible name absorbed; an unnamed primitive
 * falls back to its role, its visible text when it has any, and a short
 * description of the row it sits in.
 */
export function geometryFindingLabel(
  locator: GeometryStableLocator | undefined,
  primitiveLabel?: string,
  options: Readonly<{ naming?: GeometryCandidateNaming; repeatedRow?: boolean }> = {}
): string {
  const rowTitle = collapseWhitespace(options.naming?.rowTitle ?? '');
  if (options.repeatedRow && rowTitle !== '') {
    return `${locator?.role ?? 'row'} “${rowTitle}”`;
  }
  if (locator?.name) {
    return geometryOwnText(locator.name, options.naming?.nestedControlNames ?? []);
  }
  if (!locator) return primitiveLabel ?? 'unnamed element';
  const family = describeGeometryRowFamily(locator.rowFamily ?? locator.selfFamily);
  const text = collapseWhitespace(primitiveLabel ?? '');
  const isTagName = text === '' || HTML_TAG_LABEL.test(text);
  const index = locator.roleIndex === undefined ? '' : ` #${locator.roleIndex}`;
  return isTagName
    ? `${locator.role}${index} in ${family}`
    : `${locator.role} “${text}” in ${family}`;
}

/** Kinds a reader sees as glyphs; their optical centre is the cap band. */
const GEOMETRY_TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'numeric-text']);
/** Kinds a reader sees as a mark: an icon path, an image, a painted shape. */
const GEOMETRY_MARK_KINDS: ReadonlySet<string> = new Set(['svg', 'image', 'shape']);

/**
 * Which anchor a row's verdict comes from, decided by what the row is MADE OF
 * rather than by which anchor happens to disagree most.
 *
 * - A row mixing text with an icon, image or painted shape is judged at
 *   `visual-center`: that is the only anchor where a glyph and a mark are
 *   comparable at all.
 * - A row of nothing but text is judged at `text-baseline`, the line every
 *   reader actually sees those runs sitting on.
 * - Anything else — boxes against boxes — is judged at `block-center`.
 *
 * A block EDGE is never a verdict: two primitives of different heights have
 * different edges by construction, which is a size difference, not a
 * misalignment. The census reads `block-center`, the one anchor every kind of
 * primitive reports, so the row's composition is never inferred from a rail
 * that only some members reached.
 */
export function selectGeometryVerdictAnchor(rails: readonly DiscoveredBlockRail[]): Readonly<{
  rail: DiscoveredBlockRail;
  reason: 'mixed-kinds' | 'all-text' | 'boxes-only';
}> | null {
  const byAnchor = new Map(rails.map((rail) => [rail.anchor, rail]));
  const census =
    byAnchor.get('block-center') ??
    [...rails].sort((left, right) => right.sampleSize - left.sampleSize)[0];
  if (!census) return null;
  const kinds = census.members.map((member) => member.kind ?? '');
  const hasText = kinds.some((kind) => GEOMETRY_TEXT_KINDS.has(kind));
  const hasMark = kinds.some((kind) => GEOMETRY_MARK_KINDS.has(kind));
  const allText = kinds.length > 0 && kinds.every((kind) => GEOMETRY_TEXT_KINDS.has(kind));
  const [reason, preference] =
    hasText && hasMark
      ? (['mixed-kinds', ['visual-center', 'block-center']] as const)
      : allText
        ? (['all-text', ['text-baseline', 'visual-center', 'block-center']] as const)
        : (['boxes-only', ['block-center', 'visual-center']] as const);
  for (const anchor of preference) {
    const rail = byAnchor.get(anchor);
    if (rail) return { rail, reason };
  }
  return null;
}

/**
 * A label reads as `role \u201crow title\u201d` exactly when the accessible name
 * describes the row's contents rather than the control. That is a display
 * decision now that identity never reads a name at all.
 */
function geometryRepeatedRowLabelling(
  captures: GeometryCaptureArtifact
): (
  locator: GeometryStableLocator,
  naming: GeometryCandidateNaming | undefined,
  surfaceFamily: GeometrySurfaceFamily
) => boolean {
  const repeatedRowFamilies = collectRepeatedGeometryRowFamilies(captures);
  return (locator, naming, surfaceFamily) =>
    locator.name !== undefined &&
    locator.rowFamily !== undefined &&
    (repeatedRowFamilies.get(surfaceFamily)?.has(locator.rowFamily) ?? false) &&
    isGeometryContentAggregatedName(locator, naming);
}

/** One member of a cross-family rail, labelled and identified as a finding would be. */
export type GeometryCrossFamilyProposalMember = Readonly<{
  /** Coordinate-free structural identity: how a rail is matched across captures. */
  identity: string;
  locator: GeometryStableLocator;
  /** The key this member carries as a finding once a second capture agrees. */
  findingKey: string;
  member: GeometryRowMember;
}>;

/**
 * One `cross-family` rail ONE capture proposes. Nothing but the rendering says
 * these primitives belong on a line together, and one capture agreeing is a
 * coincidence, so a single capture never promotes one: the report shows the
 * proposal, and `createGeometryFindings` decides which outliers survive.
 */
export type GeometryCrossFamilyProposal = Readonly<{
  captureId: string;
  surfaceFamily: GeometrySurfaceFamily;
  rail: DiscoveredBlockRail;
  line: number;
  normalizedLine: number;
  /** Positionally aligned with `rail.members`. */
  members: readonly GeometryCrossFamilyProposalMember[];
}>;

/**
 * Label and identify every `cross-family` rail the observation proposes. ONE
 * labelling pipeline: a report card prints exactly what a finding would, so the
 * two can never disagree about a member's name, its offset, or the key it would
 * carry.
 *
 * A rail with a member discovery cannot name structurally is dropped: it could
 * never be recognised in the next capture, so it could never earn a finding.
 */
export function collectGeometryCrossFamilyProposals(
  captures: GeometryCaptureArtifact,
  observations: GeometryObservationArtifact
): readonly GeometryCrossFamilyProposal[] {
  const captureById = new Map(captures.captures.map((capture) => [capture.captureId, capture]));
  const aggregatedRowFamilies = collectAggregatedGeometryRowFamilies(captures);
  const labelsAsRepeatedRow = geometryRepeatedRowLabelling(captures);
  type RailMember = DiscoveredBlockRail['members'][number] &
    Partial<GeometryCapturedBlockCandidate>;
  return observations.captures.flatMap((captureObservation) => {
    const viewportHeight = captureById.get(captureObservation.captureId)?.viewport.height;
    return (captureObservation.blockRails ?? [])
      .filter((rail) => rail.evidence === 'cross-family')
      .flatMap((rail): GeometryCrossFamilyProposal[] => {
        const railMembers = rail.members as readonly RailMember[];
        const locators = railMembers.map((member) => member.locator);
        if (locators.some((locator) => locator === undefined)) return [];
        const members = railMembers.map((member, index): GeometryCrossFamilyProposalMember => {
          const raw = locators[index] as GeometryStableLocator;
          const locator = geometryIdentityLocator(raw, {
            aggregatedRowFamilies: aggregatedRowFamilies.get(captureObservation.surfaceFamily),
            ...(member.sectionScope ? { section: member.sectionScope } : {}),
          });
          return {
            identity: locatorIdentity(locator),
            locator,
            findingKey: alignmentFindingKey({
              surfaceFamily: captureObservation.surfaceFamily,
              locator,
              anchor: 'visual-center',
              axis: 'y',
              kind: 'cross-family',
            }),
            member: {
              label: geometryFindingLabel(raw, member.label ?? member.elementId, {
                ...(member.naming ? { naming: member.naming } : {}),
                repeatedRow: labelsAsRepeatedRow(
                  raw,
                  member.naming,
                  captureObservation.surfaceFamily
                ),
              }),
              primitiveId: member.primitiveId ?? member.elementId,
              ...(member.kind ? { kind: member.kind } : {}),
              coordinate: member.coordinate,
              offset: member.coordinate - rail.line,
              outlier: member.outlier,
              xStart: member.xStart,
              xEnd: member.xEnd,
              yStart: member.yStart,
              yEnd: member.yEnd,
            },
          };
        });
        return [
          {
            captureId: captureObservation.captureId,
            surfaceFamily: captureObservation.surfaceFamily,
            rail,
            line: rail.line,
            normalizedLine: viewportHeight ? Number((rail.line / viewportHeight).toFixed(4)) : 0,
            members,
          },
        ];
      });
  });
}

export function createGeometryFindings(
  captures: GeometryCaptureArtifact,
  observations: GeometryObservationArtifact
): GeometryFindingArtifact {
  const totalBySurface = new Map<string, number>();
  const boxModelNodesByCapture = new Map(
    captures.captures.map((capture) => [capture.captureId, capture.boxModelNodes ?? {}])
  );
  const captureById = new Map(captures.captures.map((capture) => [capture.captureId, capture]));
  /**
   * Dimensions vary one story at one viewport and device scale; comparing across
   * those would report a viewport-only or DPR-only difference as a theme.
   */
  const dimensionGroupKey = (capture: GeometryCapture) =>
    `${capture.storyId}\u0000${capture.viewport.width}x${capture.viewport.height}\u0000${capture.deviceScaleFactor}`;
  const capturesByDimensionGroup = new Map<string, GeometryCapture[]>();
  for (const capture of captures.captures) {
    const key = dimensionGroupKey(capture);
    capturesByDimensionGroup.set(key, [...(capturesByDimensionGroup.get(key) ?? []), capture]);
  }
  const dimensionSensitivity = (
    evidence: readonly GeometryFindingEvidence[]
  ): readonly GeometryDimensionSensitivity[] => {
    const evidenceCaptures = evidence.flatMap((item) => {
      const capture = captureById.get(item.captureId);
      return capture?.dimensions ? [capture] : [];
    });
    if (evidenceCaptures.length === 0) return [];
    const peers = [
      ...new Set(
        evidenceCaptures.flatMap(
          (capture) => capturesByDimensionGroup.get(dimensionGroupKey(capture)) ?? []
        )
      ),
    ].filter((capture) => capture.dimensions);
    const observedValues = (axis: GeometryDimensionAxis) =>
      new Set(
        evidenceCaptures.flatMap((capture) => {
          const value = capture.dimensions?.[axis];
          return value === undefined ? [] : [value];
        })
      );
    return GEOMETRY_DIMENSION_AXES.flatMap((axis) => {
      const observed = observedValues(axis);
      if (observed.size !== 1) return [];
      // Hold every other axis at the values this finding was actually seen
      // under, so an axis is only reported when it is the one that varied.
      const comparable = peers.filter((capture) =>
        GEOMETRY_DIMENSION_AXES.every((other) => {
          if (other === axis) return true;
          const value = capture.dimensions?.[other];
          return value === undefined || observedValues(other).has(value);
        })
      );
      const available = new Set(
        comparable.flatMap((capture) => {
          const value = capture.dimensions?.[axis];
          return value === undefined ? [] : [value];
        })
      );
      const [only] = [...observed];
      return available.size >= 2 && only !== undefined ? [{ axis, value: only }] : [];
    });
  };
  for (const capture of captures.captures) {
    totalBySurface.set(capture.surfaceFamily, (totalBySurface.get(capture.surfaceFamily) ?? 0) + 1);
  }
  const observedByKey = new Map<string, GeometryObservedScope>();
  for (const capture of observations.captures) {
    for (const scope of capture.scopes) {
      observedByKey.set(`${scope.captureId}\u0000${scope.scopeKey}`, scope);
    }
  }

  const aggregatedRowFamilies = collectAggregatedGeometryRowFamilies(captures);
  const labelsAsRepeatedRow = geometryRepeatedRowLabelling(captures);
  const findingGroups = new Map<
    string,
    {
      surfaceFamily: GeometrySurfaceFamily;
      locator: GeometryStableLocator;
      /** One label per capture; the merged finding prints the first capture's. */
      labels: Map<string, string>;
      anchor: GeometryExplainedAnchor;
      axis: SemanticAlignmentAxis;
      kind: 'alignment-rail' | 'row-spread' | 'cross-family';
      verdictAnchorReason?: 'mixed-kinds' | 'all-text' | 'boxes-only';
      evidence: GeometryFindingEvidence[];
    }
  >();
  for (const captureObservation of observations.captures) {
    for (const observation of captureObservation.scopes) {
      const source = materializeGeometryObservationScope(observation, [...observedByKey.values()]);
      for (const rail of source.rails ?? []) {
        const normalizedLine = roundedNormalizedLine(rail.line, source.scopeRect);
        for (const outlier of rail.outliers) {
          const candidate = outlier as typeof outlier & Partial<GeometryCapturedCandidate>;
          if (!candidate.locator) continue;
          const reference = rail.members
            .filter((member) => !member.outlier)
            .flatMap((member): GeometryCapturedCandidate[] => {
              const captured = member as typeof member & Partial<GeometryCapturedCandidate>;
              return captured.locator && captured.label && captured.primitiveId
                ? [captured as GeometryCapturedCandidate]
                : [];
            })
            .sort(
              (left, right) =>
                Math.abs(left.coordinate - rail.line) - Math.abs(right.coordinate - rail.line) ||
                Math.abs((left.yStart + left.yEnd) / 2 - (candidate.yStart + candidate.yEnd) / 2) -
                  Math.abs(
                    (right.yStart + right.yEnd) / 2 - (candidate.yStart + candidate.yEnd) / 2
                  )
            )[0];
          const identity = geometryIdentityLocator(candidate.locator, {
            aggregatedRowFamilies: aggregatedRowFamilies.get(captureObservation.surfaceFamily),
            ...(candidate.sectionScope ? { section: candidate.sectionScope } : {}),
          });
          const key = alignmentFindingKey({
            surfaceFamily: captureObservation.surfaceFamily,
            locator: identity,
            anchor: rail.anchor,
            axis: 'x',
          });
          const group = findingGroups.get(key) ?? {
            surfaceFamily: captureObservation.surfaceFamily,
            locator: identity,
            labels: new Map<string, string>(),
            anchor: rail.anchor,
            axis: 'x' as SemanticAlignmentAxis,
            kind: 'alignment-rail' as const,
            evidence: [],
          };
          if (!group.evidence.some((item) => item.captureId === captureObservation.captureId)) {
            // The label describes the evidence this capture kept, so a card can
            // never print one row's title beside another row's measurement.
            group.labels.set(
              captureObservation.captureId,
              geometryFindingLabel(candidate.locator, candidate.label ?? candidate.elementId, {
                naming: candidate.naming,
                repeatedRow: labelsAsRepeatedRow(
                  candidate.locator,
                  candidate.naming,
                  captureObservation.surfaceFamily
                ),
              })
            );
            group.evidence.push({
              captureId: captureObservation.captureId,
              scopeKey: observation.scopeKey,
              coordinate: candidate.coordinate,
              line: rail.line,
              normalizedLine,
              offset: candidate.coordinate - rail.line,
              yStart: candidate.yStart,
              yEnd: candidate.yEnd,
              ...(reference
                ? {
                    explanation: explainGeometryOffset(
                      candidate as GeometryCapturedCandidate,
                      reference,
                      rail.anchor,
                      candidate.coordinate - rail.line,
                      boxModelNodesByCapture.get(captureObservation.captureId)
                    ),
                  }
                : {}),
            });
          }
          findingGroups.set(key, group);
        }
      }
    }

    /**
     * Y rails. A rail lives inside ONE row instance, so the row median is the
     * whole evidence for that row. But one ELEMENT is one finding: the four
     * anchors a row reports it on — two block edges, two centres, sometimes a
     * baseline — are four measurements of a single question. The row picks the
     * anchor its verdict comes from, and every other anchor rides along as a
     * supporting measurement, so a card says "this icon sits 1.8px high" once
     * instead of four times with four different numbers.
     */
    const capture = captureById.get(captureObservation.captureId);
    const normalizedBlockLine = (line: number) =>
      capture?.viewport.height ? Number((line / capture.viewport.height).toFixed(4)) : 0;
    const railsByRow = new Map<string, DiscoveredBlockRail[]>();
    for (const rail of captureObservation.blockRails ?? []) {
      // `cross-family` rails answer the same question with weaker evidence, so
      // they never reach the one-capture path or pick a verdict anchor: they are
      // aggregated across captures below, at `visual-center`, or not at all.
      if (rail.evidence !== 'row-instance') continue;
      railsByRow.set(rail.rowId, [...(railsByRow.get(rail.rowId) ?? []), rail]);
    }
    for (const rowRails of railsByRow.values()) {
      const verdict = selectGeometryVerdictAnchor(rowRails);
      if (!verdict) continue;
      const { rail, reason } = verdict;
      type BlockMember = DiscoveredBlockRail['members'][number] &
        Partial<GeometryCapturedBlockCandidate>;
      const members = rail.members as readonly BlockMember[];
      const coordinates = members.map((member) => member.coordinate);
      const spread = Math.max(...coordinates) - Math.min(...coordinates);
      const rowMembers: readonly GeometryRowMember[] = members.map((member) => ({
        label: geometryFindingLabel(member.locator, member.label ?? member.elementId, {
          ...(member.naming ? { naming: member.naming } : {}),
          repeatedRow: member.locator
            ? labelsAsRepeatedRow(member.locator, member.naming, captureObservation.surfaceFamily)
            : false,
        }),
        primitiveId: member.primitiveId ?? member.elementId,
        ...(member.kind ? { kind: member.kind } : {}),
        coordinate: member.coordinate,
        offset: member.coordinate - rail.line,
        outlier: member.outlier,
        xStart: member.xStart,
        xEnd: member.xEnd,
        yStart: member.yStart,
        yEnd: member.yEnd,
      }));
      /** Every other anchor this row measured the same primitive on. */
      const supportingAnchorsFor = (primitiveId: string | undefined) =>
        rowRails.flatMap((other): GeometryAnchorMeasurement[] => {
          if (other.anchor === rail.anchor) return [];
          const match = (other.members as readonly BlockMember[]).find(
            (member) => (member.primitiveId ?? member.elementId) === primitiveId
          );
          if (!match) return [];
          const otherCoordinates = other.members.map((member) => member.coordinate);
          return [
            {
              anchor: other.anchor,
              coordinate: match.coordinate,
              line: other.line,
              offset: match.coordinate - other.line,
              spread: Math.max(...otherCoordinates) - Math.min(...otherCoordinates),
            },
          ];
        });

      if (rail.outliers.length === 0) continue;

      // Two members, one midpoint: BOTH sit half the gap from it, so blaming
      // either for `spread / 2` invents a direction the measurement does not
      // have. The row reports its spread once, naming both members.
      if (members.length === 2) {
        const [first, second] = members;
        if (!first || !second || !first.locator || !second.locator) continue;
        const rowLocator: GeometryStableLocator = {
          role: 'row',
          ...(first.locator.landmark ? { landmark: first.locator.landmark } : {}),
          ...(rail.rowFamily ? { rowFamily: rail.rowFamily } : {}),
          ...(first.locator.familyIndex === undefined
            ? {}
            : { familyIndex: first.locator.familyIndex }),
        };
        const identity = geometryIdentityLocator(rowLocator, {
          aggregatedRowFamilies: aggregatedRowFamilies.get(captureObservation.surfaceFamily),
          ...(first.sectionScope ? { section: first.sectionScope } : {}),
        });
        const key = alignmentFindingKey({
          surfaceFamily: captureObservation.surfaceFamily,
          locator: identity,
          anchor: rail.anchor,
          axis: 'y',
          kind: 'row-spread',
        });
        const group = findingGroups.get(key) ?? {
          surfaceFamily: captureObservation.surfaceFamily,
          locator: identity,
          labels: new Map<string, string>(),
          anchor: rail.anchor,
          axis: 'y' as SemanticAlignmentAxis,
          kind: 'row-spread' as const,
          verdictAnchorReason: reason,
          evidence: [],
        };
        if (!group.evidence.some((item) => item.captureId === captureObservation.captureId)) {
          const memberLabels = rowMembers.map((member) => member.label);
          group.labels.set(
            captureObservation.captureId,
            `${memberLabels[0] ?? 'row'} ↔ ${memberLabels[1] ?? 'row'}`
          );
          const rowSpreadSupport = rowRails.flatMap((other): GeometryAnchorMeasurement[] => {
            if (other.anchor === rail.anchor) return [];
            const otherCoordinates = other.members.map((member) => member.coordinate);
            return [
              {
                anchor: other.anchor,
                coordinate: other.line,
                line: other.line,
                // No member is blamed, so there is no signed offset to report:
                // the spread IS the measurement at every anchor.
                offset: 0,
                spread: Math.max(...otherCoordinates) - Math.min(...otherCoordinates),
              },
            ];
          });
          group.evidence.push({
            captureId: captureObservation.captureId,
            scopeKey: rail.rowId,
            rowId: rail.rowId,
            coordinate: rail.line,
            line: rail.line,
            normalizedLine: normalizedBlockLine(rail.line),
            offset: spread,
            yStart: Math.min(...members.map((member) => member.yStart)),
            yEnd: Math.max(...members.map((member) => member.yEnd)),
            xStart: Math.min(...members.map((member) => member.xStart)),
            xEnd: Math.max(...members.map((member) => member.xEnd)),
            anchor: rail.anchor,
            supportingAnchors: rowSpreadSupport,
            rowMembers,
            ...(first.primitiveId && second.primitiveId
              ? {
                  explanation: explainGeometryOffset(
                    second as GeometryCapturedBlockCandidate,
                    first as GeometryCapturedBlockCandidate,
                    rail.anchor,
                    second.coordinate - first.coordinate,
                    boxModelNodesByCapture.get(captureObservation.captureId)
                  ),
                }
              : {}),
          });
        }
        findingGroups.set(key, group);
        continue;
      }

      for (const outlier of rail.outliers) {
        const candidate = outlier as BlockMember;
        if (!candidate.locator || !candidate.primitiveId) continue;
        const reference = members
          .filter((member) => !member.outlier)
          .flatMap((member): GeometryCapturedBlockCandidate[] =>
            member.locator && member.label && member.primitiveId
              ? [member as GeometryCapturedBlockCandidate]
              : []
          )
          .sort(
            (left, right) =>
              Math.abs(left.coordinate - rail.line) - Math.abs(right.coordinate - rail.line) ||
              left.xStart - right.xStart
          )[0];
        const identity = geometryIdentityLocator(candidate.locator, {
          aggregatedRowFamilies: aggregatedRowFamilies.get(captureObservation.surfaceFamily),
          ...(candidate.sectionScope ? { section: candidate.sectionScope } : {}),
        });
        const key = alignmentFindingKey({
          surfaceFamily: captureObservation.surfaceFamily,
          locator: identity,
          anchor: rail.anchor,
          axis: 'y',
        });
        const group = findingGroups.get(key) ?? {
          surfaceFamily: captureObservation.surfaceFamily,
          locator: identity,
          labels: new Map<string, string>(),
          anchor: rail.anchor,
          axis: 'y' as SemanticAlignmentAxis,
          kind: 'alignment-rail' as const,
          verdictAnchorReason: reason,
          evidence: [],
        };
        if (!group.evidence.some((item) => item.captureId === captureObservation.captureId)) {
          group.labels.set(
            captureObservation.captureId,
            geometryFindingLabel(candidate.locator, candidate.label ?? candidate.elementId, {
              naming: candidate.naming,
              repeatedRow: labelsAsRepeatedRow(
                candidate.locator,
                candidate.naming,
                captureObservation.surfaceFamily
              ),
            })
          );
          const offset = candidate.coordinate - rail.line;
          group.evidence.push({
            captureId: captureObservation.captureId,
            scopeKey: rail.rowId,
            rowId: rail.rowId,
            coordinate: candidate.coordinate,
            line: rail.line,
            normalizedLine: normalizedBlockLine(rail.line),
            offset,
            yStart: candidate.yStart ?? rail.line,
            yEnd: candidate.yEnd ?? rail.line,
            xStart: candidate.xStart,
            xEnd: candidate.xEnd,
            anchor: rail.anchor,
            supportingAnchors: supportingAnchorsFor(candidate.primitiveId),
            rowMembers,
            ...(reference
              ? {
                  explanation: explainGeometryOffset(
                    candidate as GeometryCapturedBlockCandidate,
                    reference,
                    rail.anchor,
                    offset,
                    boxModelNodesByCapture.get(captureObservation.captureId)
                  ),
                }
              : {}),
          });
        }
        findingGroups.set(key, group);
      }
    }
  }

  /**
   * `cross-family` rails. Nothing but the rendering says these primitives share
   * a line, and one capture agreeing is a coincidence: the SAME member set has
   * to form the rail, and the same member has to leave the line in the same
   * direction, in two captures at least. The rail itself is never a finding —
   * its outliers are, one finding per element, keyed structurally like every
   * other Y finding and told apart from the row-instance question by its kind.
   *
   * Members are matched between captures by structural identity, never by a
   * coordinate: a line that moved as a whole is still the same line.
   */
  const railsByMemberSet = new Map<string, GeometryCrossFamilyProposal[]>();
  for (const proposal of collectGeometryCrossFamilyProposals(captures, observations)) {
    const key = `${proposal.surfaceFamily}\u0000${proposal.members
      .map((member) => member.identity)
      .sort()
      .join('\u0001')}`;
    railsByMemberSet.set(key, [...(railsByMemberSet.get(key) ?? []), proposal]);
  }
  for (const proposals of railsByMemberSet.values()) {
    if (new Set(proposals.map((proposal) => proposal.captureId)).size < 2) continue;
    const outlierIdentities = [
      ...new Set(
        proposals.flatMap((proposal) =>
          proposal.members.flatMap((member) => (member.member.outlier ? [member.identity] : []))
        )
      ),
    ].sort();
    for (const identity of outlierIdentities) {
      const missed = new Map<
        string,
        Readonly<{
          proposal: GeometryCrossFamilyProposal;
          member: GeometryCrossFamilyProposalMember;
        }>
      >();
      for (const proposal of proposals) {
        const member = proposal.members.find((candidate) => candidate.identity === identity);
        if (!member?.member.outlier) continue;
        if (!missed.has(proposal.captureId)) missed.set(proposal.captureId, { proposal, member });
      }
      if (missed.size < 2) continue;
      // One element, one direction. An element that reads high in one capture
      // and low in the next is measuring something that moves, not a line it
      // consistently misses.
      const directions = new Set(
        [...missed.values()].map(({ member }) => Math.sign(member.member.offset))
      );
      if (directions.size !== 1) continue;
      const sightings = [...missed.values()].sort((left, right) =>
        left.proposal.captureId.localeCompare(right.proposal.captureId)
      );
      const first = sightings[0];
      if (!first) continue;
      const key = first.member.findingKey;
      const group = findingGroups.get(key) ?? {
        surfaceFamily: first.proposal.surfaceFamily,
        locator: first.member.locator,
        labels: new Map<string, string>(),
        anchor: 'visual-center' as GeometryExplainedAnchor,
        axis: 'y' as SemanticAlignmentAxis,
        kind: 'cross-family' as const,
        evidence: [],
      };
      for (const { proposal, member } of sightings) {
        if (group.evidence.some((item) => item.captureId === proposal.captureId)) continue;
        group.labels.set(proposal.captureId, member.member.label);
        group.evidence.push({
          captureId: proposal.captureId,
          scopeKey: proposal.rail.rowId,
          rowId: proposal.rail.rowId,
          coordinate: member.member.coordinate,
          line: proposal.line,
          normalizedLine: proposal.normalizedLine,
          offset: member.member.offset,
          yStart: member.member.yStart,
          yEnd: member.member.yEnd,
          xStart: member.member.xStart,
          xEnd: member.member.xEnd,
          anchor: 'visual-center',
          rowMembers: proposal.members.map((item) => item.member),
        });
      }
      findingGroups.set(key, group);
    }
  }

  const findings: GeometryFinding[] = [...findingGroups.entries()].map(([key, group]) => {
    const offset =
      group.evidence.reduce((sum, evidence) => sum + evidence.offset, 0) / group.evidence.length;
    const normalizedLine =
      group.evidence.reduce((sum, evidence) => sum + evidence.normalizedLine, 0) /
      group.evidence.length;
    const evidence = group.evidence.sort((left, right) =>
      left.captureId.localeCompare(right.captureId)
    );
    const label =
      (evidence[0] ? group.labels.get(evidence[0].captureId) : undefined) ??
      [...group.labels.values()][0] ??
      geometryFindingLabel(group.locator);
    const classification = mergeGeometryClassifications(
      evidence.map((item) =>
        classifyGeometryOffsetExplanation(
          item.explanation,
          captureById.get(item.captureId)?.deviceScaleFactor ?? 1
        )
      )
    );
    const repairProposal =
      classification === 'css-defect'
        ? evidence.find(
            (item) =>
              classifyGeometryOffsetExplanation(
                item.explanation,
                captureById.get(item.captureId)?.deviceScaleFactor ?? 1
              ) === 'css-defect'
          )?.explanation?.repair
        : undefined;
    const sensitivity = dimensionSensitivity(evidence);
    const spread = evidence.flatMap((item) =>
      item.rowMembers
        ? [
            Math.max(...item.rowMembers.map((member) => member.coordinate)) -
              Math.min(...item.rowMembers.map((member) => member.coordinate)),
          ]
        : []
    );
    return {
      key,
      kind: group.kind,
      surfaceFamily: group.surfaceFamily,
      locator: group.locator,
      label,
      axis: group.axis,
      anchor: group.anchor,
      ...(group.verdictAnchorReason ? { verdictAnchorReason: group.verdictAnchorReason } : {}),
      ...(group.kind === 'row-spread' && spread.length > 0
        ? { spread: spread.reduce((sum, value) => sum + value, 0) / spread.length }
        : {}),
      normalizedLine,
      offset,
      captureCount: evidence.length,
      totalCaptureCount: totalBySurface.get(group.surfaceFamily) ?? evidence.length,
      classification,
      ...(repairProposal ? { repairProposal } : {}),
      ...(repairProposal?.repairGroup ? { repairGroup: repairProposal.repairGroup } : {}),
      ...(sensitivity.length > 0 ? { dimensionSensitivity: sensitivity } : {}),
      evidence,
    };
  });

  const measurementGroups = new Map<
    string,
    {
      surfaceFamily: GeometrySurfaceFamily;
      alignment: GeometrySemanticObservation;
      observations: Array<Readonly<{ captureId: string; alignment: GeometrySemanticObservation }>>;
    }
  >();
  for (const capture of captures.captures) {
    for (const alignment of capture.semanticAlignments ?? []) {
      if (!alignment.instance || alignment.status === 'aligned' || alignment.members.length < 2) {
        continue;
      }
      const signature = alignment.members
        .map((member) => `${member.name}:${(member.coordinate - alignment.line).toFixed(2)}`)
        .sort()
        .join('|');
      const key = makeFindingKey([
        capture.surfaceFamily,
        alignment.group,
        alignment.axis,
        alignment.anchor,
        'measurement-model',
        signature,
      ]);
      const group = measurementGroups.get(key) ?? {
        surfaceFamily: capture.surfaceFamily,
        alignment,
        observations: [],
      };
      group.observations.push({ captureId: capture.captureId, alignment });
      measurementGroups.set(key, group);
    }
  }
  for (const [key, group] of measurementGroups) {
    if (group.observations.length < 2) continue;
    const offset = Math.max(
      ...group.alignment.members.map((member) => Math.abs(member.coordinate - group.alignment.line))
    );
    const evidence = group.observations.map(({ captureId, alignment }) => ({
      captureId,
      scopeKey: alignment.instance ?? alignment.group,
      coordinate: alignment.members[0]?.coordinate ?? alignment.line,
      line: alignment.line,
      normalizedLine: 0,
      offset,
      yStart: 0,
      yEnd: 0,
    }));
    findings.push({
      key,
      kind: 'measurement-model-divergence',
      surfaceFamily: group.surfaceFamily,
      label: group.alignment.group,
      axis: group.alignment.axis,
      anchor: group.alignment.anchor,
      offset,
      captureCount: new Set(group.observations.map(({ captureId }) => captureId)).size,
      totalCaptureCount: totalBySurface.get(group.surfaceFamily) ?? 1,
      // No dimension axis here: semantic-alignment observations are captured on
      // one representative capture by design, so an absence elsewhere would be
      // an artifact of the pipeline rather than a theme or locale difference.
      evidence,
    });
  }

  return {
    version: 1,
    findings: findings.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.surfaceFamily.localeCompare(right.surfaceFamily) ||
        left.label.localeCompare(right.label) ||
        left.key.localeCompare(right.key)
    ),
  };
}

export type GeometryBlockRailParityMember = Readonly<{
  name: string;
  primitiveId: string;
  markerCoordinate: number;
  discoveryCoordinate: number;
  coordinateDelta: number;
  markerOffset: number;
  discoveryOffset: number;
  offsetDelta: number;
}>;

export type GeometryBlockRailParityRow = Readonly<{
  instance: string;
  markerLine: number;
  discoveryLine: number | null;
  rowId: string | null;
  members: readonly GeometryBlockRailParityMember[];
  /** Marker members no Y candidate covers, and Y members no marker declares. */
  markerOnly: readonly string[];
  discoveryOnly: readonly string[];
  maxCoordinateDelta: number;
  maxOffsetDelta: number;
}>;

export type GeometryBlockRailParityReport = Readonly<{
  version: 1;
  captureId: string;
  group: string;
  anchor: SemanticAlignmentAnchor;
  /** Physical pixel both sides are snapped to before anything is compared. */
  quantization: number;
  rows: readonly GeometryBlockRailParityRow[];
  matchedMemberCount: number;
  maxCoordinateDelta: number;
  maxOffsetDelta: number;
}>;

/**
 * Prove the marker-free Y discovery reproduces a marker-based instance rule.
 * Two different questions are answered separately and must not be conflated:
 * `coordinateDelta` is whether both stages MEASURE one element the same way,
 * and `offsetDelta` is whether they place the row line the same way — which
 * they only can when they saw the same members, so the members each side saw
 * alone are listed rather than quietly averaged away.
 */
export function compareMarkerAlignmentsToBlockRails(
  capture: GeometryCapture,
  blockRails: readonly DiscoveredBlockRail[],
  options: Readonly<{ group: string }>
): GeometryBlockRailParityReport {
  const groups = (capture.semanticAlignments ?? []).filter(
    (alignment) => alignment.group === options.group
  );
  const anchor = groups[0]?.anchor ?? 'visual-center';
  const snap = (value: number) => quantizeGeometryCoordinate(value, capture.deviceScaleFactor);
  const rows = groups.map((alignment): GeometryBlockRailParityRow => {
    const markerIds = new Set(
      alignment.members.flatMap((member) => (member.primitiveId ? [member.primitiveId] : []))
    );
    const scored = blockRails
      .filter((rail) => rail.evidence === 'row-instance' && rail.anchor === alignment.anchor)
      .map((rail) => {
        const members = rail.members as readonly (DiscoveredBlockRail['members'][number] &
          Partial<GeometryCapturedBlockCandidate>)[];
        return {
          rail,
          members,
          shared: members.filter(
            (member) => member.primitiveId !== undefined && markerIds.has(member.primitiveId)
          ).length,
        };
      })
      .filter((entry) => entry.shared > 0)
      .sort((left, right) => right.shared - left.shared || left.rail.line - right.rail.line);
    const best = scored[0];
    const discoveryByPrimitive = new Map(
      (best?.members ?? []).flatMap((member) =>
        member.primitiveId ? [[member.primitiveId, member] as const] : []
      )
    );
    const members = alignment.members.flatMap((member): GeometryBlockRailParityMember[] => {
      const discovered = member.primitiveId
        ? discoveryByPrimitive.get(member.primitiveId)
        : undefined;
      if (!discovered || !best) return [];
      const markerCoordinate = snap(member.coordinate);
      const discoveryCoordinate = snap(discovered.coordinate);
      const markerOffset = snap(markerCoordinate - alignment.line);
      const discoveryOffset = snap(discoveryCoordinate - best.rail.line);
      return [
        {
          name: member.name,
          primitiveId: member.primitiveId ?? '',
          markerCoordinate,
          discoveryCoordinate,
          coordinateDelta: Number((discoveryCoordinate - markerCoordinate).toFixed(4)),
          markerOffset,
          discoveryOffset,
          offsetDelta: Number((discoveryOffset - markerOffset).toFixed(4)),
        },
      ];
    });
    const matchedIds = new Set(members.map((member) => member.primitiveId));
    const absMax = (values: readonly number[]) =>
      values.length === 0 ? 0 : Math.max(...values.map((value) => Math.abs(value)));
    return {
      instance: alignment.instance ?? alignment.group,
      markerLine: snap(alignment.line),
      discoveryLine: best ? best.rail.line : null,
      rowId: best?.rail.rowId ?? null,
      members,
      markerOnly: alignment.members
        .filter((member) => !member.primitiveId || !matchedIds.has(member.primitiveId))
        .map((member) => member.name),
      discoveryOnly: (best?.members ?? [])
        .filter((member) => !member.primitiveId || !matchedIds.has(member.primitiveId))
        .map((member) => member.label ?? member.elementId),
      maxCoordinateDelta: absMax(members.map((member) => member.coordinateDelta)),
      maxOffsetDelta: absMax(members.map((member) => member.offsetDelta)),
    };
  });
  return {
    version: 1,
    captureId: capture.captureId,
    group: options.group,
    anchor,
    quantization: capture.deviceScaleFactor > 0 ? 1 / capture.deviceScaleFactor : 1,
    rows,
    matchedMemberCount: rows.reduce((total, row) => total + row.members.length, 0),
    maxCoordinateDelta: Math.max(0, ...rows.map((row) => row.maxCoordinateDelta)),
    maxOffsetDelta: Math.max(0, ...rows.map((row) => row.maxOffsetDelta)),
  };
}

/** How close two offsets may be and still describe one measured element. */
const GEOMETRY_REKEY_OFFSET_TOLERANCE = 0.25;

/**
 * Pair reviewed entries that vanished with findings that appeared, when they
 * are the same element under a better key. A structural identity change re-keys
 * everything it improves, and reporting that as "72 resolved, 71 new" throws
 * away every decision a human already made.
 *
 * Deterministic and one-to-one: candidates are considered in key order, the
 * label match is taken before the measurement match, and each side is consumed
 * once. An entry that carries no reviewed identity cannot be paired at all —
 * it is reported as resolved, which is the honest answer.
 */
export function matchRekeyedGeometryFindings(
  resolved: readonly string[],
  newFindings: readonly GeometryFinding[],
  ledger: GeometryLedger
): readonly GeometryRekeyedFinding[] {
  const claimed = new Set<string>();
  const pairs: GeometryRekeyedFinding[] = [];
  const candidates = [...newFindings].sort((left, right) => left.key.localeCompare(right.key));
  for (const from of [...resolved].sort()) {
    const identity = ledger.findings[from]?.identity;
    if (!identity) continue;
    const baseline = ledger.findings[from]?.baseline?.offset;
    const matches = (finding: GeometryFinding, reason: 'label' | 'measurement') => {
      if (claimed.has(finding.key)) return false;
      if (finding.surfaceFamily !== identity.surfaceFamily) return false;
      if (reason === 'label') return finding.label === identity.label;
      return (
        finding.axis === identity.axis &&
        finding.anchor === identity.anchor &&
        baseline !== undefined &&
        Math.abs(Math.abs(finding.offset) - Math.abs(baseline)) <= GEOMETRY_REKEY_OFFSET_TOLERANCE
      );
    };
    const matched =
      candidates.find((finding) => matches(finding, 'label')) ??
      candidates.find((finding) => matches(finding, 'measurement'));
    if (!matched) continue;
    claimed.add(matched.key);
    pairs.push({
      from,
      to: matched.key,
      reason: matched.label === identity.label ? 'label' : 'measurement',
      label: identity.label,
    });
  }
  return pairs;
}

/** One marker member, and whether marker-free discovery reproduced it. */
export type GeometryMarkerRemovalMember = Readonly<{
  captureId: string;
  instance: string;
  name: string;
  primitiveId: string | null;
  markerOffset: number;
  discoveryOffset: number | null;
  offsetDelta: number | null;
  matched: boolean;
  /** Why a member did not match, so the gap is actionable rather than a count. */
  reason?: 'no-primitive-id' | 'not-observed' | 'anchor-missing' | 'offset-differs';
}>;

export type GeometryMarkerRemovalRule = Readonly<{
  group: string;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  captureIds: readonly string[];
  memberCount: number;
  matchedMemberCount: number;
  /** True only when EVERY member matched on EVERY capture the rule appears in. */
  ready: boolean;
  members: readonly GeometryMarkerRemovalMember[];
}>;

export type GeometryMarkerRemovalReadiness = Readonly<{
  version: 1;
  /** Physical pixel both sides snap to; a rule may not be judged finer. */
  quantization: number;
  rules: readonly GeometryMarkerRemovalRule[];
  readyRules: readonly string[];
}>;

/**
 * Can this marker rule be deleted yet? A marker rule is business-code weight:
 * a `data-geometry-*` attribute someone has to keep correct. It may go only
 * once marker-free discovery observes the SAME primitive, at the SAME anchor,
 * with the same offset from its row line, on every capture the rule appears in.
 * One capture where a member is invisible to discovery is one regression the
 * removal would hide, so a single unmatched member holds the whole rule back.
 */
export function assessGeometryMarkerRemoval(
  captures: GeometryCaptureArtifact,
  observations: GeometryObservationArtifact
): GeometryMarkerRemovalReadiness {
  // A marker rule names the members of ONE DOM row, so only a row-instance rail
  // can answer whether discovery reproduced it. A `cross-family` rail reaching
  // the same element is a different, weaker claim, and letting it stand in would
  // report a marker as removable on evidence the marker never had.
  const blockRailsByCapture = new Map(
    observations.captures.map((capture) => [
      capture.captureId,
      (capture.blockRails ?? []).filter((rail) => rail.evidence === 'row-instance'),
    ])
  );
  const quantization = Math.max(
    ...captures.captures.map((capture) =>
      capture.deviceScaleFactor > 0 ? 1 / capture.deviceScaleFactor : 1
    ),
    0
  );
  const rules = new Map<
    string,
    {
      axis: SemanticAlignmentAxis;
      anchor: SemanticAlignmentAnchor;
      captureIds: Set<string>;
      members: GeometryMarkerRemovalMember[];
    }
  >();
  for (const capture of captures.captures) {
    const blockRails = blockRailsByCapture.get(capture.captureId) ?? [];
    const snap = (value: number) => quantizeGeometryCoordinate(value, capture.deviceScaleFactor);
    const tolerance = capture.deviceScaleFactor > 0 ? 1 / capture.deviceScaleFactor : 1;
    for (const alignment of [
      ...(capture.semanticAlignments ?? []),
      ...(capture.semanticBaselines ?? []),
    ]) {
      const rule = rules.get(alignment.group) ?? {
        axis: alignment.axis,
        anchor: alignment.anchor,
        captureIds: new Set<string>(),
        members: [],
      };
      rule.captureIds.add(capture.captureId);
      // The row a marker rule describes is the discovered rail of the same
      // anchor sharing the most members with it: a rail is one row instance,
      // and a rule that spans rows has nothing to be compared against.
      const markerIds = new Set(
        alignment.members.flatMap((member) => (member.primitiveId ? [member.primitiveId] : []))
      );
      const best = blockRails
        .filter((rail) => rail.anchor === alignment.anchor)
        .map((rail) => ({
          rail,
          members: rail.members as readonly (DiscoveredBlockRail['members'][number] &
            Partial<GeometryCapturedBlockCandidate>)[],
        }))
        .map((entry) => ({
          ...entry,
          shared: entry.members.filter(
            (member) => member.primitiveId !== undefined && markerIds.has(member.primitiveId)
          ).length,
        }))
        .filter((entry) => entry.shared > 0)
        .sort((left, right) => right.shared - left.shared || left.rail.line - right.rail.line)[0];
      const observed = new Map(
        (best?.members ?? []).flatMap((member) =>
          member.primitiveId ? [[member.primitiveId, member] as const] : []
        )
      );
      for (const member of alignment.members) {
        const markerOffset = snap(snap(member.coordinate) - alignment.line);
        const discovered = member.primitiveId ? observed.get(member.primitiveId) : undefined;
        const discoveryOffset =
          discovered && best ? snap(snap(discovered.coordinate) - best.rail.line) : null;
        const offsetDelta =
          discoveryOffset === null ? null : Number((discoveryOffset - markerOffset).toFixed(4));
        const reason = !member.primitiveId
          ? ('no-primitive-id' as const)
          : !best
            ? ('anchor-missing' as const)
            : !discovered
              ? ('not-observed' as const)
              : Math.abs(offsetDelta ?? 0) > tolerance
                ? ('offset-differs' as const)
                : undefined;
        rule.members.push({
          captureId: capture.captureId,
          instance: alignment.instance ?? alignment.group,
          name: member.name,
          primitiveId: member.primitiveId ?? null,
          markerOffset,
          discoveryOffset,
          offsetDelta,
          matched: reason === undefined,
          ...(reason ? { reason } : {}),
        });
      }
      rules.set(alignment.group, rule);
    }
  }
  const assessed = [...rules.entries()]
    .map(([group, rule]): GeometryMarkerRemovalRule => {
      const matchedMemberCount = rule.members.filter((member) => member.matched).length;
      return {
        group,
        axis: rule.axis,
        anchor: rule.anchor,
        captureIds: [...rule.captureIds].sort(),
        memberCount: rule.members.length,
        matchedMemberCount,
        ready: rule.members.length > 0 && matchedMemberCount === rule.members.length,
        members: rule.members,
      };
    })
    .sort((left, right) => left.group.localeCompare(right.group));
  return {
    version: 1,
    quantization,
    rules: assessed,
    readyRules: assessed.filter((rule) => rule.ready).map((rule) => rule.group),
  };
}

export function diffGeometryFindings(
  artifact: GeometryFindingArtifact,
  ledger: GeometryLedger,
  offsetTolerance = 0.5
): GeometryFindingDiff {
  const byKey = new Map(artifact.findings.map((finding) => [finding.key, finding]));
  const current = artifact.findings.map((finding) => ({
    finding,
    state: ledger.findings[finding.key]?.status ?? ('new' as const),
  }));
  const newFindings = current.filter(({ state }) => state === 'new').map(({ finding }) => finding);
  const resolved = Object.entries(ledger.findings)
    .filter(([, entry]) => entry.baseline && entry.status !== 'ignored')
    .map(([key]) => key)
    .filter((key) => !byKey.has(key))
    .sort();
  const rekeyed = matchRekeyedGeometryFindings(resolved, newFindings, ledger);
  const rekeyedFrom = new Set(rekeyed.map((pair) => pair.from));
  const rekeyedTo = new Map(rekeyed.map((pair) => [pair.to, pair.from] as const));
  const changed = artifact.findings.filter((finding) => {
    const carried = rekeyedTo.get(finding.key);
    const baseline = (carried ? ledger.findings[carried] : ledger.findings[finding.key])?.baseline;
    return baseline ? Math.abs(finding.offset - baseline.offset) > offsetTolerance : false;
  });
  return {
    current,
    // A re-keyed finding is not new: the decision travels to its new key.
    new: newFindings.filter((finding) => !rekeyedTo.has(finding.key)),
    changed,
    resolved: resolved.filter((key) => !rekeyedFrom.has(key)),
    rekeyed,
  };
}

/**
 * Record previously unseen findings without moving an existing baseline. New
 * entries land on `debt`, never `wont-fix`: telling those two apart is the
 * review, and a tool that guessed it would be recording a decision nobody made.
 */
export function triageGeometryFindings(
  artifact: GeometryFindingArtifact,
  ledger: GeometryLedger,
  status: Extract<GeometryLedgerStatus, 'new' | 'debt'> = 'debt'
): GeometryLedger {
  const findings: Record<string, GeometryLedgerEntry> = { ...ledger.findings };
  const reviewedIdentity = (finding: GeometryFinding): GeometryReviewedIdentity => ({
    label: finding.label,
    axis: finding.axis,
    anchor: finding.anchor,
    surfaceFamily: finding.surfaceFamily,
  });
  // Migrate before recording: a re-keyed entry keeps its status, its reason and
  // its baseline, so a structural identity change never re-opens a review or
  // silently re-baselines the offset a human accepted.
  const diff = diffGeometryFindings(artifact, ledger);
  const byKey = new Map(artifact.findings.map((finding) => [finding.key, finding]));
  for (const pair of diff.rekeyed) {
    const entry = findings[pair.from];
    const finding = byKey.get(pair.to);
    if (!entry || !finding) continue;
    delete findings[pair.from];
    findings[pair.to] = { ...entry, identity: reviewedIdentity(finding) };
  }
  for (const finding of artifact.findings) {
    const existing = findings[finding.key];
    findings[finding.key] = existing
      ? { ...existing, identity: existing.identity ?? reviewedIdentity(finding) }
      : {
          status,
          baseline: { offset: finding.offset },
          identity: reviewedIdentity(finding),
        };
  }
  return {
    version: 1,
    ...(ledger.tokens ? { tokens: ledger.tokens } : {}),
    findings: Object.fromEntries(
      Object.entries(findings).sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

export function geometryLocatorMatches(
  candidate: GeometryStableLocator,
  expected: GeometryStableLocator
): boolean {
  return (
    candidate.role === expected.role &&
    (expected.name === undefined || candidate.name === expected.name) &&
    (expected.rowName === undefined || candidate.rowName === expected.rowName) &&
    (expected.rowFamily === undefined || candidate.rowFamily === expected.rowFamily) &&
    (expected.familyIndex === undefined || candidate.familyIndex === expected.familyIndex) &&
    (expected.selfFamily === undefined || candidate.selfFamily === expected.selfFamily) &&
    (expected.roleIndex === undefined || candidate.roleIndex === expected.roleIndex) &&
    (expected.landmark === undefined ||
      (candidate.landmark?.role === expected.landmark.role &&
        (expected.landmark.name === undefined ||
          candidate.landmark.name === expected.landmark.name)))
  );
}

/** Ledger labels make discovery quality measurable; promoted locators make UI coverage measurable. */
export function computeGeometryQualityMetrics(
  captures: GeometryCaptureArtifact,
  ledger: GeometryLedger
): GeometryQualityMetrics {
  const labeledEntries = Object.values(ledger.findings).filter((entry) => entry.status !== 'new');
  const ignoredFindingCount = labeledEntries.filter((entry) => entry.status === 'ignored').length;
  const interactiveLocators = new Map<
    string,
    Readonly<{ surfaceFamily: GeometrySurfaceFamily; locator: GeometryStableLocator }>
  >();
  for (const capture of captures.captures) {
    for (const scope of capture.scopes) {
      for (const candidate of scope.candidates) {
        if (!['button', 'link', 'textbox', 'combobox'].includes(candidate.locator.role)) continue;
        // Coverage counts RENDERED controls, so it reads the raw locator name
        // too. Identity drops the name on purpose; a metric that dropped it
        // would report two distinct buttons of one DOM shape as one control.
        interactiveLocators.set(
          `${capture.surfaceFamily}\u0000${locatorIdentity(candidate.locator)}\u0000${
            candidate.locator.name ?? ''
          }`,
          { surfaceFamily: capture.surfaceFamily, locator: candidate.locator }
        );
      }
    }
  }
  const promotedMembers = Object.entries(ledger.findings).flatMap(([key, entry]) =>
    entry.status === 'promoted' && entry.contract
      ? entry.contract.members.map((locator) => ({
          surfaceFamily: key.split('/')[1] ?? '',
          locator,
        }))
      : []
  );
  const constrainedInteractivePrimitiveCount = [...interactiveLocators.values()].filter(
    (candidate) =>
      promotedMembers.some(
        (member) =>
          candidate.surfaceFamily === member.surfaceFamily &&
          geometryLocatorMatches(candidate.locator, member.locator)
      )
  ).length;
  return {
    labeledFindingCount: labeledEntries.length,
    ignoredFindingCount,
    discoveryPrecision:
      labeledEntries.length === 0
        ? null
        : (labeledEntries.length - ignoredFindingCount) / labeledEntries.length,
    interactivePrimitiveCount: interactiveLocators.size,
    constrainedInteractivePrimitiveCount,
    geometryCoverage:
      interactiveLocators.size === 0
        ? null
        : constrainedInteractivePrimitiveCount / interactiveLocators.size,
  };
}

/** A deliberately small, deterministic algebra used by the browser gate. */
export function evaluateGeometryContractValues(
  relation: GeometryContractRelation | undefined,
  values: readonly number[],
  tolerance: number,
  token?: Readonly<{ value: number }>
): GeometryContractEvaluation {
  if (values.length === 0) return { valid: false, maximumError: Number.POSITIVE_INFINITY };
  if (!relation || relation.kind === 'coincident') {
    if (values.length < 2) return { valid: false, maximumError: Number.POSITIVE_INFINITY };
    const maximumError = Math.max(...values) - Math.min(...values);
    return { valid: maximumError <= tolerance, maximumError };
  }
  if (!token) return { valid: false, maximumError: Number.POSITIVE_INFINITY };
  const errors = values.map((value) =>
    relation.kind === 'box-model-multiple-of-token'
      ? Math.abs(value - Math.round(value / token.value) * token.value)
      : Math.abs(value - token.value)
  );
  const maximumError = Math.max(...errors);
  return { valid: maximumError <= tolerance, maximumError };
}

/** One matched element of a contract member, already measured by the browser. */
export type GeometryContractMemberSample = Readonly<{
  description: string;
  /** Rendered position, so one element resolved by two members is detectable. */
  elementKey?: string;
  /** Anchor coordinate, or the summed box-model value the relation reads. */
  value: number | null;
  /** Per-property computed values, so a failure can print the exact terms. */
  propertyValues?: Readonly<Record<string, number | null>>;
  hidden?: boolean;
}>;

export type GeometryContractMemberResolution = Readonly<{
  label: string;
  /** Elements the locator matched, before `all` truncation. */
  matchCount: number;
  /** Populated only for a named member Playwright can cross-check. */
  nameMatchCount?: number;
  playwrightNameCount?: number;
  samples: readonly GeometryContractMemberSample[];
}>;

function formatContractValue(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * The gate's decision layer, separated from the browser measurement so it is
 * testable without a page. A member that resolves ambiguously is a defect in
 * the contract, not an invitation to measure the first match: an ambiguous
 * member contributes no value, and the relation is only judged once every
 * member resolved.
 */
export function evaluateGeometryContractResolutions(
  contract: GeometryContract,
  resolutions: readonly GeometryContractMemberResolution[],
  token?: GeometryResolvedToken
): readonly string[] {
  const relation = contract.relation ?? { kind: 'coincident' as const };
  const properties = geometryContractRelationProperties(relation);
  const violations: string[] = [];
  const values: Array<Readonly<{ label: string; value: number }>> = [];
  // One element resolved by two members counts its value twice and hides the
  // narrower member behind the broader one; the contract, not the measurement,
  // is what needs fixing.
  const coveredBy = new Map<string, string>();
  contract.members.forEach((member, index) => {
    const resolution = resolutions[index];
    if (!resolution) {
      violations.push(`${contract.name}: member ${index + 1} was never resolved`);
      return;
    }
    const { label } = resolution;
    if (
      resolution.nameMatchCount !== undefined &&
      resolution.playwrightNameCount !== undefined &&
      resolution.nameMatchCount !== resolution.playwrightNameCount
    ) {
      violations.push(
        `${contract.name}: accessible name ${JSON.stringify(member.name)} resolves to ${resolution.nameMatchCount} ${member.role} element(s) in the capture naming model but ${resolution.playwrightNameCount} through Playwright getByRole`
      );
    }
    if (resolution.matchCount === 0) {
      violations.push(`${contract.name}: locator ${label} is missing`);
      return;
    }
    if (!member.all && resolution.matchCount !== 1) {
      violations.push(
        `${contract.name}: locator ${label} matched ${resolution.matchCount} elements`
      );
      return;
    }
    for (const sample of resolution.samples) {
      if (sample.hidden) {
        violations.push(`${contract.name}: locator ${label} is hidden`);
        continue;
      }
      if (sample.value === null) {
        const terms = (properties ?? [])
          .map((property) => {
            const value = sample.propertyValues?.[property];
            return `${property}=${value === null || value === undefined ? 'none' : formatContractValue(value)}`;
          })
          .join(', ');
        violations.push(
          `${contract.name}: ${label} did not resolve ${(properties ?? []).join(' + ')} to a pixel length (${sample.description}: ${terms})`
        );
        continue;
      }
      if (sample.elementKey !== undefined) {
        const owner = coveredBy.get(sample.elementKey);
        if (owner !== undefined && owner !== label) {
          violations.push(
            `${contract.name}: ${label} and ${owner} both resolve ${sample.description}; one member already covers it`
          );
          continue;
        }
        coveredBy.set(sample.elementKey, label);
      }
      values.push({ label, value: sample.value });
    }
  });
  if (violations.length > 0) return violations;

  const evaluation = evaluateGeometryContractValues(
    relation,
    values.map(({ value }) => value),
    contract.tolerance,
    token
  );
  if (evaluation.valid) return violations;
  violations.push(
    `${contract.name}: ${relation.kind} error ${evaluation.maximumError}px exceeds ${contract.tolerance}px${
      token ? ` (token ${token.cssVariable}=${token.value}px)` : ''
    } (${values.map(({ label, value }) => `${label}=${formatContractValue(value)}`).join(', ')})`
  );
  return violations;
}

export type GeometryInkCenterSample = Readonly<{
  label: string;
  description?: string;
  inkCenter: number;
  containsSvg: boolean;
}>;

export type GeometryInkCenterWitness = Readonly<{
  medianInkCenter: number;
  members: readonly Readonly<{
    label: string;
    description?: string;
    inkCenter: number;
    inkCenterOffset: number;
  }>[];
  /** Present only when a member's ink center is more than 1 CSS px off. */
  designQuestion?: string;
}>;

/**
 * A box rail says nothing about where the ink lands. Icons on one trailing rail
 * can share a layout edge exactly and still read as unaligned because their
 * glyph whitespace differs, so the witness records each icon's ink centre
 * against the group's median ink centre.
 */
export function summarizeGeometryInkCenters(
  contractName: string,
  samples: readonly GeometryInkCenterSample[]
): GeometryInkCenterWitness | undefined {
  const icons = samples.filter((sample) => sample.containsSvg);
  if (icons.length < 2) return undefined;
  const sorted = [...icons.map((sample) => sample.inkCenter)].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianInkCenter =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const members = icons.map((sample) => ({
    label: sample.label,
    ...(sample.description ? { description: sample.description } : {}),
    inkCenter: Number(sample.inkCenter.toFixed(3)),
    inkCenterOffset: Number((sample.inkCenter - medianInkCenter).toFixed(3)),
  }));
  const worst = members.reduce((left, right) =>
    Math.abs(right.inkCenterOffset) > Math.abs(left.inkCenterOffset) ? right : left
  );
  return {
    medianInkCenter: Number(medianInkCenter.toFixed(3)),
    members,
    ...(Math.abs(worst.inkCenterOffset) > 1
      ? {
          designQuestion: `${contractName}: ${worst.label} sits ${formatContractValue(Math.abs(worst.inkCenterOffset))}px ${
            worst.inkCenterOffset < 0 ? 'before' : 'after'
          } the median ink centre of this icon rail. Should an icon rail be ink-centre coincident, or is a shared layout-box edge the intended rule?`,
        }
      : {}),
  };
}

/**
 * The CSS property a repair term actually edits. `padding` and `margin` have
 * logical longhands per edge; a border edge is a width; a gap belongs to the
 * axis, not to one of its two edges. Guessing `gap-inline-end` would hand an
 * agent a property that does not exist.
 */
export function geometryRepairCssProperty(
  term: GeometryDeclaredBoxModelTerm,
  edge: GeometryRepairProposal['edge']
): string {
  if (term === 'gap') return edge.startsWith('inline') ? 'column-gap' : 'row-gap';
  if (term === 'border') return `border-${edge}-width`;
  return `${term}-${edge}`;
}

export type GeometryRepairTextOptions = Readonly<{
  maxTerms?: number;
  /**
   * A Tailwind class list runs to hundreds of characters, which is what an
   * agent greps for and what makes a one-line summary unreadable. So the card
   * body keeps it and the summary line leaves it out; neither truncates it,
   * because half a class list greps for nothing.
   */
  includeClassName?: boolean;
}>;

/**
 * One repair term as a sentence an agent can act on: which component, which
 * rendered node inside it, which property, how far off, and the class list that
 * most likely declares it.
 */
export function formatGeometryRepairTerm(
  term: GeometryRepairTerm,
  proposal: Pick<GeometryRepairProposal, 'edge' | 'commonAncestor' | 'component'>,
  options: GeometryRepairTextOptions = {}
): string {
  const owner = term.component ?? proposal.component ?? proposal.commonAncestor;
  const property = geometryRepairCssProperty(term.term, proposal.edge);
  const magnitude = Number(Math.abs(term.delta).toFixed(2));
  const direction = term.delta > 0 ? '多' : '少';
  const className =
    term.className && options.includeClassName !== false ? `（class: ${term.className}）` : '';
  return `${owner} 里 ${term.element} 的 ${property} ${direction} ${magnitude}px${className}`;
}

/** The proposal's terms as sentences, strongest first. */
export function formatGeometryRepairProposal(
  proposal: GeometryRepairProposal,
  options: GeometryRepairTextOptions = {}
): string {
  return proposal.terms
    .slice(0, options.maxTerms ?? 3)
    .map((term) => formatGeometryRepairTerm(term, proposal, options))
    .join('；');
}

export type GeometryRatchetViolation = Readonly<{
  kind: 'offset-regression' | 'unreviewed-finding';
  key: string;
  label: string;
  surfaceFamily: GeometrySurfaceFamily;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  status?: GeometryLedgerStatus;
  baseline?: number;
  current: number;
  /** The slack allowed above `|baseline|`, in CSS pixels. */
  tolerance?: number;
}>;

/**
 * The coarsest device pixel this finding was measured with. A finding merged
 * across a 2× and a 1× capture is only as precise as the 1× one, so holding it
 * to half a pixel would fail on rounding the measurement cannot avoid.
 */
export function geometryFindingDevicePixel(
  finding: GeometryFinding,
  captures: GeometryCaptureArtifact
): number {
  const scaleByCapture = new Map(
    captures.captures.map((capture) => [capture.captureId, capture.deviceScaleFactor])
  );
  const devicePixels = finding.evidence.map((evidence) => {
    const scale = scaleByCapture.get(evidence.captureId);
    return scale && scale > 0 ? 1 / scale : 1;
  });
  return devicePixels.length > 0 ? Math.max(...devicePixels) : 1;
}

/**
 * The ratchet. A ledger baseline used to be a number the report PRINTED; this
 * is what makes it a number CI enforces.
 *
 * Two rules, both about the ledger being complete and monotonic:
 * every measured finding must be reviewed, and no reviewed finding may drift
 * further from its line than the review recorded, allowing one device pixel for
 * the rounding the measurement itself cannot avoid. `ignored` opts out — that
 * is what ignoring one means — and `promoted` is left to the contract check
 * that already gates it exactly, rather than being gated twice and loosely.
 */
export function checkGeometryLedgerRatchet(
  artifact: GeometryFindingArtifact,
  ledger: GeometryLedger,
  captures: GeometryCaptureArtifact
): readonly GeometryRatchetViolation[] {
  const ratcheted = new Set<GeometryLedgerStatus>(GEOMETRY_RATCHETED_LEDGER_STATUSES);
  return artifact.findings.flatMap((finding): GeometryRatchetViolation[] => {
    const identity = {
      key: finding.key,
      label: finding.label,
      surfaceFamily: finding.surfaceFamily,
      axis: finding.axis,
      anchor: finding.anchor,
      current: finding.offset,
    };
    const entry = ledger.findings[finding.key];
    if (!entry) return [{ kind: 'unreviewed-finding', ...identity }];
    if (!ratcheted.has(entry.status)) return [];
    const baseline = entry.baseline?.offset;
    if (baseline === undefined) return [];
    const tolerance = geometryFindingDevicePixel(finding, captures);
    if (Math.abs(finding.offset) <= Math.abs(baseline) + tolerance) return [];
    return [
      {
        kind: 'offset-regression',
        ...identity,
        status: entry.status,
        baseline,
        tolerance,
      },
    ];
  });
}

export type GeometryFixVerification = Readonly<{
  key: string;
  label: string;
  /** Absent from findings: the rail no longer reports this element at all. */
  resolved: boolean;
  offset: number;
  tolerance: number;
  passed: boolean;
  reason?: string;
}>;

/**
 * Close the flywheel: a finding whose offset is now within one device pixel of
 * its line is `fixed`, and its baseline moves to what was just measured — which
 * makes it the STRICTEST entry in the ledger from then on. Everything else is
 * reported and changes nothing: a verification that re-baselined a failure
 * would be a ratchet that only ever loosens.
 */
export function verifyGeometryFixes(
  artifact: GeometryFindingArtifact,
  ledger: GeometryLedger,
  captures: GeometryCaptureArtifact,
  keys: readonly string[]
): Readonly<{
  verifications: readonly GeometryFixVerification[];
  ledger: GeometryLedger;
}> {
  const byKey = new Map(artifact.findings.map((finding) => [finding.key, finding]));
  const findings: Record<string, GeometryLedgerEntry> = { ...ledger.findings };
  const verifications = keys.map((key): GeometryFixVerification => {
    const entry = ledger.findings[key];
    const finding = byKey.get(key);
    const label = finding?.label ?? entry?.identity?.label ?? key;
    const refuse = (reason: string): GeometryFixVerification => ({
      key,
      label,
      resolved: !finding,
      offset: finding?.offset ?? 0,
      tolerance: 0,
      passed: false,
      reason,
    });
    if (!entry) return refuse('no ledger entry reviews this finding');
    // A promoted finding is gated EXACTLY by its contract. Moving it to `fixed`
    // would leave that contract uncompiled and silently drop the tightest rule
    // in the file, so retiring the contract has to be the deliberate step.
    if (entry.status === 'promoted') {
      return refuse('a promoted finding is gated by its contract; retire the contract first');
    }
    if (!finding) {
      // The element is no longer measured off any line: nothing left to allow.
      findings[key] = { ...entry, status: 'fixed', baseline: { offset: 0 } };
      return { key, label, resolved: true, offset: 0, tolerance: 0, passed: true };
    }
    const tolerance = geometryFindingDevicePixel(finding, captures);
    const passed = Math.abs(finding.offset) <= tolerance;
    if (passed) {
      findings[key] = { ...entry, status: 'fixed', baseline: { offset: finding.offset } };
    }
    return {
      key,
      label,
      resolved: false,
      offset: finding.offset,
      tolerance,
      passed,
      ...(passed
        ? {}
        : {
            reason: `|offset| ${Math.abs(finding.offset).toFixed(3)}px exceeds one device pixel (${tolerance.toFixed(3)}px)`,
          }),
    };
  });
  if (verifications.some((verification) => !verification.passed)) {
    return { verifications, ledger };
  }
  return {
    verifications,
    ledger: {
      version: 1,
      ...(ledger.tokens ? { tokens: ledger.tokens } : {}),
      findings: Object.fromEntries(
        Object.entries(findings).sort(([left], [right]) => left.localeCompare(right))
      ),
    },
  };
}

/** Every finding key the artifact assigns to one repair group. */
export function geometryFindingKeysInRepairGroup(
  artifact: GeometryFindingArtifact,
  repairGroup: string
): readonly string[] {
  return artifact.findings
    .filter((finding) => finding.repairGroup === repairGroup)
    .map((finding) => finding.key)
    .sort();
}

export function formatGeometryRatchetViolations(
  violations: readonly GeometryRatchetViolation[]
): string {
  return violations
    .map((violation) =>
      violation.kind === 'unreviewed-finding'
        ? [
            `unreviewed finding ${violation.key}`,
            `  ${violation.surfaceFamily} · ${violation.label} · ${violation.axis}/${violation.anchor}`,
            `  measured ${violation.current.toFixed(3)}px and no ledger entry reviews it.`,
            '  Run `pnpm geometry:report <dir>` then `pnpm geometry:triage <dir>` and commit the ledger.',
          ].join('\n')
        : [
            `regressed finding ${violation.key}`,
            `  ${violation.surfaceFamily} · ${violation.label} · ${violation.axis}/${violation.anchor} (${violation.status})`,
            `  baseline ${(violation.baseline ?? 0).toFixed(3)}px → current ${violation.current.toFixed(3)}px`,
            `  allowed |offset| ≤ ${(Math.abs(violation.baseline ?? 0) + (violation.tolerance ?? 0)).toFixed(3)}px (baseline + ${(violation.tolerance ?? 0).toFixed(3)}px device pixel)`,
          ].join('\n')
    )
    .join('\n\n');
}

/**
 * Only `promoted` compiles. `new`, `debt`, `wont-fix`, `fixed` and `ignored`
 * produce no contract at all — a status is a REVIEW, and a review that started
 * gating the product without a human writing the contract would be a rule
 * nobody wrote. A `fixed` finding is held to its own near-zero baseline by the
 * ratchet; promoting it to a contract is a separate, deliberate step.
 */
export function compileGeometryContracts(ledger: GeometryLedger): GeometryContractArtifact {
  const contracts = Object.entries(ledger.findings).flatMap(([findingKey, entry]) => {
    if (entry.status !== 'promoted') return [];
    if (!entry.contract) {
      throw new Error(`Promoted geometry finding ${findingKey} has no contract`);
    }
    const relation = entry.contract.relation ?? { kind: 'coincident' as const };
    if (relation.kind === 'coincident' && entry.contract.members.length < 2) {
      throw new Error(`Geometry contract ${entry.contract.name} needs at least two members`);
    }
    const token = relation.kind === 'coincident' ? undefined : ledger.tokens?.[relation.token];
    if (relation.kind !== 'coincident' && !token) {
      throw new Error(
        `Geometry contract ${entry.contract.name} references missing token ${relation.token}`
      );
    }
    if (
      relation.kind === 'box-model-multiple-of-token' &&
      token?.expected !== undefined &&
      token.expected <= 0
    ) {
      throw new Error(`Geometry token ${relation.token} must be positive for multiple-of checks`);
    }
    if (relation.kind === 'box-model-sum-equals-token') {
      if (relation.properties.length === 0) {
        throw new Error(
          `Geometry contract ${entry.contract.name} sums no properties; use box-model-equals-token for one property`
        );
      }
      if (new Set(relation.properties).size !== relation.properties.length) {
        throw new Error(
          `Geometry contract ${entry.contract.name} sums the same property twice: ${relation.properties.join(', ')}`
        );
      }
    }
    if (relation.kind !== 'coincident' && entry.contract.members.length < 1) {
      throw new Error(`Geometry contract ${entry.contract.name} needs at least one member`);
    }
    return [{ ...entry.contract, findingKey }];
  });
  const names = new Set<string>();
  for (const contract of contracts) {
    if (names.has(contract.name)) throw new Error(`Duplicate geometry contract: ${contract.name}`);
    names.add(contract.name);
  }
  return {
    version: 1,
    ...(ledger.tokens ? { tokens: ledger.tokens } : {}),
    contracts: contracts.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
