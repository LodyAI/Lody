import { expect, type Page } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
  CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES,
  CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  discoverRepeatedLayoutScopes,
  isGeometryPaintedShape,
  isSpacingRhythmMultiple,
  selectVisualRowSlots,
  quantizeGeometryCoordinate,
  type ChatWorkspaceSpacingAuditProperty,
  type ChatWorkspaceGeometryAnchor,
  type ChatWorkspaceGeometrySnapshot,
  type GeometryRect,
  type GeometryViolation,
  type AlignmentRailFamily,
  type DiscoveredAlignmentRail,
  type DiscoveredBlockRail,
  type LayoutTopologyNode,
  type SemanticAlignmentAnchor,
  type SemanticAlignmentAxis,
  type SemanticAlignmentPolicy,
  type SemanticBaselineMode,
  type SemanticGeometryStatus,
  type SpacingMeasurement,
} from '../../../src/lib/chat-workspace-geometry';
import {
  geometryCanvasFontString,
  geometryCapBandCenter,
  measureGeometryCapBand,
} from '../../../src/lib/geometry-text-cap-band';
import {
  geometryElementReactFiber,
  geometryReactFiberComponentName,
} from '../../../src/lib/geometry-react-fiber';
import {
  evaluateGeometryContractResolutions,
  geometryContractRelationProperties,
  materializeGeometryObservationScope,
  observeGeometryCaptures,
  resolveGeometryDesignToken,
  type GeometryBoxModelPathStep,
  type GeometryCandidateNaming,
  type GeometryCapturedBlockCandidate,
  type GeometryCapturedCandidate,
  type GeometryCapturedScope,
  type GeometryContractMemberResolution,
  type GeometryStableLocator,
  type GeometryObservationCache,
  type GeometryContractArtifact,
  type GeometryResolvedToken,
  type GeometrySurfaceFamily,
} from '../../../src/lib/geometry-constraint-system';

type BrowserMeasurement = Readonly<{
  snapshot: ChatWorkspaceGeometrySnapshot;
  spacingMeasurements: readonly SpacingMeasurement[];
}>;

export type BrowserSpacingAuditEntry = Readonly<{
  element: string;
  anchor: string | null;
  scopeAnchor: string | null;
  rect: GeometryRect;
  violations: readonly Readonly<{
    property: ChatWorkspaceSpacingAuditProperty;
    value: number;
  }>[];
}>;

export type BrowserSemanticBaselineEntry = Readonly<{
  groupLabel: string;
  mode: SemanticBaselineMode;
  rect: GeometryRect;
  line: number;
  spread: number;
  aligned: boolean;
  measurable: boolean;
  status: SemanticGeometryStatus;
  members: readonly Readonly<{
    name: string;
    text: string | null;
    coordinate: number;
    delta: number;
    rect: GeometryRect;
    /** `dom-N`, shared with capture, so a baseline member IS a discovered one. */
    primitiveId?: string;
  }>[];
}>;

export type BrowserSemanticAlignmentEntry = Readonly<{
  groupLabel: string;
  axis: SemanticAlignmentAxis;
  anchor: SemanticAlignmentAnchor;
  policy: SemanticAlignmentPolicy;
  rect: GeometryRect;
  line: number;
  aligned: boolean;
  measurable: boolean;
  status: SemanticGeometryStatus;
  spread: number;
  members: readonly Readonly<{
    name: string;
    text: string | null;
    coordinate: number;
    delta: number;
    rect: GeometryRect;
    /**
     * The same `dom-N` identity capture assigns, so a marker-based member and a
     * discovered Y candidate can be compared as ONE element rather than by
     * whichever rectangles happen to overlap.
     */
    primitiveId?: string;
  }>[];
}>;

export type BrowserAlignmentRailDiscoveryScope = Readonly<{
  scope: string;
  identity: string;
  source: 'hint' | 'auto';
  depth: number;
  rect: GeometryRect;
  contentHash: string;
  reusedFromCaptureId?: string;
  capturedScope: GeometryCapturedScope;
  candidateCount: number;
  rails: readonly DiscoveredAlignmentRail[];
  railFamilies: readonly AlignmentRailFamily[];
  topology?: Readonly<{
    signature: string;
    instanceCount: number;
    confidence: number;
  }>;
}>;

export type ChatWorkspaceGeometryCaptureOptions = Readonly<{
  aggregateScopes?: readonly string[];
  excludedScopes?: readonly string[];
}>;

const anchorValues = Object.values(CHAT_WORKSPACE_GEOMETRY_ANCHORS);
const STABILITY_TOLERANCE = 0.01;
const MAX_SETTLING_FRAMES = 8;

/**
 * Shared browser-side primitive measurement for capture and contract validation.
 * Keep this function closure-free: capture serializes it into the page once.
 */
export function measureGeometryElementInBrowser(
  element: Element,
  space: 'ink' | 'layout-box'
): GeometryRect {
  const plainRect = (rect: DOMRectReadOnly) => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
  const union = (rects: readonly GeometryRect[]) => {
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const layoutRect = plainRect(element.getBoundingClientRect());
  if (space === 'layout-box') return layoutRect;

  const svgElements = (
    element.matches('svg') ? [element] : [...element.querySelectorAll('svg')]
  ).filter((candidate): candidate is SVGGraphicsElement => {
    if (!(candidate instanceof SVGGraphicsElement)) return false;
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const svgRects = svgElements.flatMap((svg) => {
    try {
      const box = svg.getBBox();
      const matrix = svg.getScreenCTM();
      if (!matrix || box.width <= 0 || box.height <= 0) return [];
      const points = [
        new DOMPoint(box.x, box.y),
        new DOMPoint(box.x + box.width, box.y),
        new DOMPoint(box.x, box.y + box.height),
        new DOMPoint(box.x + box.width, box.y + box.height),
      ].map((point) => point.matrixTransform(matrix));
      const left = Math.min(...points.map((point) => point.x));
      const top = Math.min(...points.map((point) => point.y));
      const right = Math.max(...points.map((point) => point.x));
      const bottom = Math.max(...points.map((point) => point.y));
      return [{ x: left, y: top, width: right - left, height: bottom - top }];
    } catch {
      return [plainRect(svg.getBoundingClientRect())];
    }
  });
  const svgInk = union(svgRects);
  if (svgInk) return svgInk;

  const textElements = [element, ...element.querySelectorAll<Element>('*')];
  const textRects = textElements.flatMap((owner) =>
    Array.from(owner.childNodes).flatMap((node) => {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map(plainRect);
    })
  );
  return union(textRects) ?? layoutRect;
}

/**
 * Shared browser-side vertical anchors for one measured primitive. `inkTop` and
 * `inkHeight` come from the SAME rect the X candidates use, so an SVG's box
 * centre here already IS its transformed path-bounds centre and an image's or a
 * field's is its box centre. Only text needs more: its visual centre is the
 * cap-height band of a fixed reference glyph, which is what a reader lines an
 * icon up against, and the difference between that and the line box centre is
 * returned as its own typography term.
 *
 * Keep this function closure-free: capture serializes it into the page once.
 */
export function measureGeometryBlockAnchorsInBrowser(
  element: Element,
  kind: string,
  inkTop: number,
  inkHeight: number
): Readonly<{
  blockStart: number;
  blockCenter: number;
  blockEnd: number;
  visualCenter: number;
  textBaseline: number | null;
  typographyOffset: number;
}> {
  const blockStart = inkTop;
  const blockEnd = inkTop + inkHeight;
  const blockCenter = inkTop + inkHeight / 2;
  if (kind !== 'text' && kind !== 'numeric-text') {
    return {
      blockStart,
      blockCenter,
      blockEnd,
      visualCenter: blockCenter,
      textBaseline: null,
      typographyOffset: 0,
    };
  }
  const boxFallback = {
    blockStart,
    blockCenter,
    blockEnd,
    visualCenter: blockCenter,
    textBaseline: null,
    typographyOffset: 0,
  };
  const style = getComputedStyle(element);
  // A baseline and a cap-height band describe ONE line box. Text that wraps has
  // neither: the marker below would report the LAST line, which is not what the
  // row is aligned against, so such a primitive keeps its box anchors only.
  const lineHeight = Number.parseFloat(style.lineHeight);
  const singleLineHeight = Number.isFinite(lineHeight)
    ? lineHeight
    : Number.parseFloat(style.fontSize) * 2;
  if (!Number.isFinite(singleLineHeight) || inkHeight > singleLineHeight * 1.6) {
    return boxFallback;
  }
  const marker = document.createElement('span');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText =
    'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
  element.append(marker);
  const baseline = marker.getBoundingClientRect().top;
  marker.remove();
  // An element that does not lay out its children — a control, a replaced
  // element, anything that ignores the marker — reports it at the viewport
  // origin. That is not a baseline; it is the absence of one.
  if (baseline < blockStart - 1 || baseline > blockEnd + 1) return boxFallback;
  // The font string, the canvas cap-band measurement and the band centre are
  // owned by `src/lib/geometry-text-cap-band.ts` and injected as page globals,
  // so the `?geometry=1` overlay and this capture cannot disagree about one row.
  const capBandHelpers = globalThis as typeof globalThis & {
    __lodyGeometryFontString?: typeof geometryCanvasFontString;
    __lodyGeometryCapBand?: typeof measureGeometryCapBand;
    __lodyGeometryCapBandCenter?: typeof geometryCapBandCenter;
  };
  const fontString = capBandHelpers.__lodyGeometryFontString;
  const capBand = capBandHelpers.__lodyGeometryCapBand;
  const capBandCenter = capBandHelpers.__lodyGeometryCapBandCenter;
  if (!fontString || !capBand || !capBandCenter) {
    throw new Error('Geometry cap-band helpers are missing');
  }
  const band = capBand(fontString(style), style.fontSize);
  const { ascent, descent } = band;
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    return { ...boxFallback, textBaseline: baseline };
  }
  const visualCenter = capBandCenter(baseline, band);
  return {
    blockStart,
    blockCenter,
    blockEnd,
    visualCenter,
    textBaseline: baseline,
    typographyOffset: visualCenter - blockCenter,
  };
}

/**
 * A deliberately small subset of the accessible-name computation, sized to what
 * Playwright's `getByRole(..., { name })` resolves for the widgets this capture
 * measures. Capture and gate share this one function so a finding can never be
 * named by a rule the gate cannot reproduce.
 *
 * Keep this function closure-free: capture serializes it into the page once.
 */
export function computeAccessibleNameInBrowser(element: Element): string {
  const NAME_FROM_CONTENT = [
    'button',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
  ];
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const explicitRole = element.getAttribute('role');
  const role =
    explicitRole ??
    (element.matches('button')
      ? 'button'
      : element.matches('a[href]')
        ? 'link'
        : element.matches('input, textarea')
          ? 'textbox'
          : element.matches('select')
            ? 'combobox'
            : element.matches('img, svg')
              ? 'img'
              : '');
  const isHidden = (candidate: Element) => {
    if (candidate.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(candidate);
    return style.display === 'none' || style.visibility === 'hidden';
  };
  const textFrom = (owner: Element): string => {
    if (isHidden(owner)) return '';
    const parts: string[] = [];
    for (const node of Array.from(owner.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? '');
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as Element;
      const childLabel = normalize(child.getAttribute('aria-label'));
      if (childLabel) {
        parts.push(childLabel);
        continue;
      }
      if (child.matches('img')) {
        parts.push(normalize(child.getAttribute('alt')));
        continue;
      }
      if (child.matches('svg')) {
        const title = child.querySelector('title');
        parts.push(normalize(title?.textContent));
        continue;
      }
      parts.push(textFrom(child));
    }
    return normalize(parts.join(' '));
  };

  const labelledBy = normalize(element.getAttribute('aria-labelledby'));
  if (labelledBy) {
    const referenced = labelledBy
      .split(' ')
      .map((id) => element.ownerDocument.getElementById(id))
      .filter((candidate): candidate is HTMLElement => Boolean(candidate))
      .map((candidate) => normalize(candidate.getAttribute('aria-label')) || textFrom(candidate))
      .filter((value) => value !== '');
    if (referenced.length > 0) return referenced.join(' ').slice(0, 96);
  }
  const ariaLabel = normalize(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel.slice(0, 96);
  if (element.matches('img')) {
    const alt = normalize(element.getAttribute('alt'));
    if (alt) return alt.slice(0, 96);
  }
  if (element.matches('svg')) {
    const svgTitle = normalize(element.querySelector('title')?.textContent);
    if (svgTitle) return svgTitle.slice(0, 96);
  }
  if (element.matches('input, textarea')) {
    const placeholder = normalize(element.getAttribute('placeholder'));
    if (placeholder) return placeholder.slice(0, 96);
  }
  if (NAME_FROM_CONTENT.includes(role)) {
    const content = textFrom(element);
    if (content) return content.slice(0, 96);
  }
  return normalize(element.getAttribute('title')).slice(0, 96);
}

function rectsAreNear(left: GeometryRect, right: GeometryRect): boolean {
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(left[key] - right[key]) <= STABILITY_TOLERANCE
  );
}

function snapshotsAreNear(
  left: ChatWorkspaceGeometrySnapshot,
  right: ChatWorkspaceGeometrySnapshot
): boolean {
  return anchorValues.every((anchor) => {
    const leftRect = left[anchor];
    const rightRect = right[anchor];
    if (!leftRect || !rightRect) return leftRect === rightRect;
    return rectsAreNear(leftRect, rightRect);
  });
}

async function nextLayoutFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })
  );
}

async function readMeasurement(page: Page): Promise<BrowserMeasurement> {
  return page.evaluate(
    ({ anchorMap, anchors, attribute }) => {
      const snapshot: Partial<Record<string, GeometryRect>> = {};

      for (const anchor of anchors) {
        const elements = document.querySelectorAll(`[${attribute}="${anchor}"]`);
        if (elements.length > 1) {
          throw new Error(`Expected one ${attribute}="${anchor}", found ${elements.length}`);
        }
        const element = elements.item(0);
        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        snapshot[anchor] = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      }

      const readLength = (anchor: string, property: 'gap' | 'paddingBottom'): number => {
        const element = document.querySelector(`[${attribute}="${anchor}"]`);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`Cannot read ${property}: ${attribute}="${anchor}" is missing`);
        }
        const value = Number.parseFloat(getComputedStyle(element)[property]);
        if (!Number.isFinite(value)) {
          throw new Error(`${anchor}.${property} did not resolve to a pixel length`);
        }
        return value;
      };

      return {
        snapshot: snapshot as ChatWorkspaceGeometrySnapshot,
        spacingMeasurements: [
          {
            name: `${anchorMap.greetingRegion}.gap`,
            value: readLength(anchorMap.greetingRegion, 'gap'),
          },
          {
            name: `${anchorMap.composerBand}.paddingBottom`,
            value: readLength(anchorMap.composerBand, 'paddingBottom'),
          },
        ],
      };
    },
    {
      anchorMap: CHAT_WORKSPACE_GEOMETRY_ANCHORS,
      anchors: anchorValues,
      attribute: CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
    }
  );
}

/**
 * Wait for explicit browser signals, then require two consecutive animation
 * frames to report the same geometry. The bounded frame loop avoids both
 * arbitrary sleeps and scheduler-dependent polling.
 */
export async function measureSettledChatWorkspace(page: Page): Promise<BrowserMeasurement> {
  // Same deadline as the report's other readiness waits: this is an explicit
  // signal, never a sleep, and the only thing a longer wait buys is tolerance
  // of a loaded machine — which must not decide whether a measurement happens.
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 90_000,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  let previous: BrowserMeasurement | null = null;
  for (let frame = 0; frame < MAX_SETTLING_FRAMES; frame += 1) {
    await nextLayoutFrame(page);
    const current = await readMeasurement(page);
    if (previous && snapshotsAreNear(previous.snapshot, current.snapshot)) return current;
    previous = current;
  }

  throw new Error(`Workspace geometry did not settle within ${MAX_SETTLING_FRAMES} frames`);
}

export function requireGeometryRect(
  snapshot: ChatWorkspaceGeometrySnapshot,
  anchor: ChatWorkspaceGeometryAnchor
): GeometryRect {
  const rect = snapshot[anchor];
  expect(rect, `Missing measured geometry anchor: ${anchor}`).toBeDefined();
  return rect as GeometryRect;
}

export function formatGeometryViolations(violations: readonly GeometryViolation[]): string {
  return violations.map((violation) => `- [${violation.code}] ${violation.message}`).join('\n');
}

export async function auditChatWorkspaceSpacing(
  page: Page
): Promise<readonly BrowserSpacingAuditEntry[]> {
  const measurements = await page.evaluate(
    ({ anchors, attribute, properties }) => {
      const root = document.querySelector(`[${attribute}="${anchors.workspaceShell}"]`);
      if (!(root instanceof HTMLElement)) throw new Error('Workspace shell is missing');

      const results: Array<{
        element: string;
        anchor: string | null;
        scopeAnchor: string | null;
        rect: GeometryRect;
        values: Array<{ property: string; value: number }>;
      }> = [];
      const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          (style.clip !== 'auto' && style.clip !== '') ||
          style.clipPath !== 'none'
        ) {
          continue;
        }
        const typedStyle = element.computedStyleMap?.();
        const usesLineHeight =
          element.matches('button, input, select, textarea') ||
          Array.from(element.childNodes).some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
          );
        const values = properties.flatMap((property) => {
          if (property === 'lineHeight' && !usesLineHeight) return [];
          const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          const typedValue = typedStyle?.get(cssProperty)?.toString();
          if (typedValue === 'auto' || typedValue === 'normal') return [];
          const value = Number.parseFloat(style[property]);
          return Number.isFinite(value) && value !== 0 ? [{ property, value }] : [];
        });
        if (values.length === 0) continue;

        const anchor = element.getAttribute(attribute);
        const scopeAnchor = element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;
        const classNames = Array.from(element.classList).slice(0, 2);
        results.push({
          element:
            anchor ??
            `${element.tagName.toLowerCase()}${classNames.map((name) => `.${name}`).join('')}`,
          anchor,
          scopeAnchor,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          values,
        });
      }
      return results;
    },
    {
      anchors: CHAT_WORKSPACE_GEOMETRY_ANCHORS,
      attribute: CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
      properties: CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES,
    }
  );

  return measurements.flatMap((measurement) => {
    const violations = measurement.values.filter(
      ({ value }) =>
        !isSpacingRhythmMultiple(
          Math.abs(value),
          CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep,
          CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance
        )
    );
    return violations.length > 0
      ? [
          {
            element: measurement.element,
            anchor: measurement.anchor,
            scopeAnchor: measurement.scopeAnchor,
            rect: measurement.rect,
            violations: violations as readonly Readonly<{
              property: ChatWorkspaceSpacingAuditProperty;
              value: number;
            }>[],
          },
        ]
      : [];
  });
}

/** Both capture and the gate measure through the same two page-side functions. */
export async function installGeometryBrowserHelpers(page: Page): Promise<void> {
  await page.addScriptTag({
    content: [
      `globalThis.__lodyMeasureGeometryElement = ${measureGeometryElementInBrowser.toString()};`,
      `globalThis.__lodyAccessibleName = ${computeAccessibleNameInBrowser.toString()};`,
      `globalThis.__lodyGeometryFontString = ${geometryCanvasFontString.toString()};`,
      `globalThis.__lodyGeometryCapBand = ${measureGeometryCapBand.toString()};`,
      `globalThis.__lodyGeometryCapBandCenter = ${geometryCapBandCenter.toString()};`,
      `globalThis.__lodyGeometrySelectRowSlots = ${selectVisualRowSlots.toString()};`,
      `globalThis.__lodyGeometryIsPaintedShape = ${isGeometryPaintedShape.toString()};`,
      `globalThis.__lodyMeasureGeometryBlockAnchors = ${measureGeometryBlockAnchorsInBrowser.toString()};`,
      `globalThis.__lodyGeometryElementFiber = ${geometryElementReactFiber.toString()};`,
      `globalThis.__lodyGeometryFiberComponentName = ${geometryReactFiberComponentName.toString()};`,
    ].join('\n'),
  });
}

export async function captureChatWorkspaceGeometryScopes(
  page: Page,
  options: ChatWorkspaceGeometryCaptureOptions = {}
): Promise<readonly GeometryCapturedScope[]> {
  await installGeometryBrowserHelpers(page);
  const snapshot = await page.evaluate(
    ({ discoveryAttribute, aggregateScopes, excludedScopes }) => {
      const measureGeometryElement = (
        globalThis as typeof globalThis & {
          __lodyMeasureGeometryElement?: typeof measureGeometryElementInBrowser;
        }
      ).__lodyMeasureGeometryElement;
      if (!measureGeometryElement) throw new Error('Geometry measurement helper is missing');
      const accessibleName = (
        globalThis as typeof globalThis & {
          __lodyAccessibleName?: typeof computeAccessibleNameInBrowser;
        }
      ).__lodyAccessibleName;
      if (!accessibleName) throw new Error('Geometry accessible-name helper is missing');
      const measureBlockAnchors = (
        globalThis as typeof globalThis & {
          __lodyMeasureGeometryBlockAnchors?: typeof measureGeometryBlockAnchorsInBrowser;
        }
      ).__lodyMeasureGeometryBlockAnchors;
      if (!measureBlockAnchors) throw new Error('Geometry block-anchor helper is missing');
      const selectRowSlots = (
        globalThis as typeof globalThis & {
          __lodyGeometrySelectRowSlots?: typeof selectVisualRowSlots;
        }
      ).__lodyGeometrySelectRowSlots;
      if (!selectRowSlots) throw new Error('Geometry row-slot helper is missing');
      const isPaintedShapeStyle = (
        globalThis as typeof globalThis & {
          __lodyGeometryIsPaintedShape?: typeof isGeometryPaintedShape;
        }
      ).__lodyGeometryIsPaintedShape;
      if (!isPaintedShapeStyle) throw new Error('Geometry painted-shape helper is missing');
      const elementFiber = (
        globalThis as typeof globalThis & {
          __lodyGeometryElementFiber?: typeof geometryElementReactFiber;
        }
      ).__lodyGeometryElementFiber;
      const fiberComponentName = (
        globalThis as typeof globalThis & {
          __lodyGeometryFiberComponentName?: typeof geometryReactFiberComponentName;
        }
      ).__lodyGeometryFiberComponentName;
      if (!elementFiber || !fiberComponentName) {
        throw new Error('Geometry React component-name helper is missing');
      }
      const isRendered = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          // `sr-only` deliberately stays in the accessibility tree. Its
          // clipped text range can still report the full label width, so a
          // non-zero rect alone is not evidence that the primitive is painted.
          (style.clip === 'auto' || style.clip === '') &&
          style.clipPath === 'none' &&
          rect.right >= 0 &&
          rect.bottom >= 0 &&
          rect.left <= innerWidth &&
          rect.top <= innerHeight
        );
      };
      const hasDirectText = (element: Element) =>
        Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
        );
      const candidateKind = (element: Element) => {
        if (element.matches('button, [role="button"]')) return 'button';
        if (element.matches('a')) return 'link';
        if (element.matches('input, select, textarea')) return 'field';
        if (element.matches('svg')) return 'svg';
        if (element.matches('img')) return 'image';
        if (!hasDirectText(element)) return null;
        const text = element.textContent?.trim().replace(/\s+/g, ' ') ?? '';
        return /^[+\-\u2212\d\s]+$/.test(text) ? 'numeric-text' : 'text';
      };
      type VisualPrimitive = Readonly<{
        element: Element;
        primitiveId: string;
        locator: GeometryStableLocator;
        label: string;
        kind: string;
        alignmentMode?: 'flow' | 'centered';
        space: 'ink' | 'layout-box';
        rect: Readonly<{ x: number; y: number; width: number; height: number }>;
      }>;
      const plainRect = (rect: DOMRectReadOnly) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      const directText = (element: Element) =>
        Array.from(element.childNodes)
          .filter(
            (node): node is Text =>
              node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
          )
          .map((node) => node.textContent?.trim() ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      const allElements = [document.body, ...document.body.querySelectorAll<Element>('*')];
      const idByElement = new Map(
        allElements.map((element, index) => [element, `dom-${index + 1}`] as const)
      );
      const cssPixels = (value: string) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const describeBoxModelNode = (element: Element) => {
        const attributes = [
          ['role', element.getAttribute('role')],
          ['aria-label', element.getAttribute('aria-label')],
          ['data-slot', element.getAttribute('data-slot')],
          [discoveryAttribute, element.getAttribute(discoveryAttribute)],
        ]
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([name, value]) => `[${name}=${value.replace(/\s+/g, ' ').slice(0, 48)}]`)
          .join('');
        return `${element.tagName.toLowerCase()}${attributes}`;
      };
      /**
       * The two source pointers a repair ticket needs. Both are optional and
       * failure-tolerant: a node React never rendered, or a production build
       * with no readable fiber, simply contributes no component name.
       */
      const sourcePointers = (element: Element) => {
        const className = element.getAttribute('class')?.replace(/\s+/g, ' ').trim();
        let component: string | undefined;
        try {
          component = fiberComponentName(elementFiber(element));
        } catch {
          component = undefined;
        }
        return {
          ...(className ? { className } : {}),
          ...(component ? { component } : {}),
        };
      };
      const boxModelPath = (
        element: Element,
        boundary: Element
      ): readonly GeometryBoxModelPathStep[] => {
        const path: GeometryBoxModelPathStep[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          const parent = node.parentElement;
          const nodeRect = node.getBoundingClientRect();
          const nodeStyle = getComputedStyle(node);
          const parentRect = parent?.getBoundingClientRect();
          const parentStyle = parent ? getComputedStyle(parent) : null;
          const renderedSiblings = parent
            ? Array.from(parent.children).filter(
                (sibling) => sibling !== node && isRendered(sibling)
              )
            : [];
          const hasSiblingBefore = renderedSiblings.some(
            (sibling) => sibling.getBoundingClientRect().right <= nodeRect.left + 0.5
          );
          const hasSiblingAfter = renderedSiblings.some(
            (sibling) => sibling.getBoundingClientRect().left >= nodeRect.right - 0.5
          );
          const hasSiblingAbove = renderedSiblings.some(
            (sibling) => sibling.getBoundingClientRect().bottom <= nodeRect.top + 0.5
          );
          const hasSiblingBelow = renderedSiblings.some(
            (sibling) => sibling.getBoundingClientRect().top >= nodeRect.bottom - 0.5
          );
          const horizontalGap = parentStyle
            ? cssPixels(parentStyle.columnGap === 'normal' ? '0' : parentStyle.columnGap)
            : 0;
          const verticalGap = parentStyle
            ? cssPixels(parentStyle.rowGap === 'normal' ? '0' : parentStyle.rowGap)
            : 0;
          const startToParent = parentRect ? nodeRect.left - parentRect.left : 0;
          const endToParent = parentRect ? parentRect.right - nodeRect.right : 0;
          const startPadding = parentStyle ? cssPixels(parentStyle.paddingLeft) : 0;
          const endPadding = parentStyle ? cssPixels(parentStyle.paddingRight) : 0;
          const startBorder = parentStyle ? cssPixels(parentStyle.borderLeftWidth) : 0;
          const endBorder = parentStyle ? cssPixels(parentStyle.borderRightWidth) : 0;
          const startMargin = cssPixels(nodeStyle.marginLeft);
          const endMargin = cssPixels(nodeStyle.marginRight);
          const startGap = hasSiblingBefore ? horizontalGap : 0;
          const endGap = hasSiblingAfter ? horizontalGap : 0;
          const blockStartToParent = parentRect ? nodeRect.top - parentRect.top : 0;
          const blockEndToParent = parentRect ? parentRect.bottom - nodeRect.bottom : 0;
          const blockStartPadding = parentStyle ? cssPixels(parentStyle.paddingTop) : 0;
          const blockEndPadding = parentStyle ? cssPixels(parentStyle.paddingBottom) : 0;
          const blockStartBorder = parentStyle ? cssPixels(parentStyle.borderTopWidth) : 0;
          const blockEndBorder = parentStyle ? cssPixels(parentStyle.borderBottomWidth) : 0;
          const blockStartMargin = cssPixels(nodeStyle.marginTop);
          const blockEndMargin = cssPixels(nodeStyle.marginBottom);
          const blockStartGap = hasSiblingAbove ? verticalGap : 0;
          const blockEndGap = hasSiblingBelow ? verticalGap : 0;
          path.push({
            nodeId: idByElement.get(node) ?? 'dom-unknown',
            element: describeBoxModelNode(node),
            ...sourcePointers(node),
            ...(parent ? { parentId: idByElement.get(parent) ?? 'dom-unknown' } : {}),
            startToParent,
            endToParent,
            centerToParent: parentRect
              ? nodeRect.left + nodeRect.width / 2 - (parentRect.left + parentRect.width / 2)
              : 0,
            inlineStart: {
              padding: startPadding,
              border: startBorder,
              margin: startMargin,
              gap: startGap,
              layout: startToParent - startPadding - startBorder - startMargin - startGap,
            },
            inlineEnd: {
              padding: endPadding,
              border: endBorder,
              margin: endMargin,
              gap: endGap,
              layout: endToParent - endPadding - endBorder - endMargin - endGap,
            },
            blockStartToParent,
            blockEndToParent,
            blockCenterToParent: parentRect
              ? nodeRect.top + nodeRect.height / 2 - (parentRect.top + parentRect.height / 2)
              : 0,
            // Whatever `align-items`, line boxes or sibling distribution added
            // beyond the declared terms lands in `layout`, exactly as on the
            // inline axis, so a centred row's residue is never called a defect.
            blockStart: {
              padding: blockStartPadding,
              border: blockStartBorder,
              margin: blockStartMargin,
              gap: blockStartGap,
              layout:
                blockStartToParent -
                blockStartPadding -
                blockStartBorder -
                blockStartMargin -
                blockStartGap,
            },
            blockEnd: {
              padding: blockEndPadding,
              border: blockEndBorder,
              margin: blockEndMargin,
              gap: blockEndGap,
              layout:
                blockEndToParent - blockEndPadding - blockEndBorder - blockEndMargin - blockEndGap,
            },
          });
          if (node === boundary) break;
        }
        return path;
      };
      const nativeRole = (element: Element) => {
        const explicit = element.getAttribute('role');
        if (explicit) return explicit;
        if (element.matches('button')) return 'button';
        if (element.matches('a[href]')) return 'link';
        if (element.matches('input, textarea')) return 'textbox';
        if (element.matches('select')) return 'combobox';
        if (element.matches('img, svg')) return 'img';
        if (element.matches('main')) return 'main';
        if (element.matches('aside')) return 'complementary';
        if (element.matches('nav')) return 'navigation';
        if (element.matches('section')) return 'region';
        if (element.matches('header')) return 'banner';
        if (element.matches('footer')) return 'contentinfo';
        return 'text';
      };
      const rowStructureFamily = (row: Element) => {
        const token = (element: Element) =>
          `${element.tagName.toLowerCase()}[${nativeRole(element)}]`;
        return `${token(row)}>${Array.from(row.children).map(token).join(',')}`;
      };
      /**
       * The nearest declared discovery scope of the ELEMENT, independent of which
       * scope is being snapshotted, so one primitive keeps one section however
       * many overlapping scopes measure it.
       */
      const sectionScopeOf = (element: Element) =>
        element.closest<Element>(`[${discoveryAttribute}]`)?.getAttribute(discoveryAttribute) ??
        undefined;
      /**
       * Which instance of its row family, inside its own declared section, an
       * element is. Numbered once for the whole DOCUMENT, so two overlapping
       * scopes that both snapshot one element cannot hand it two identities —
       * and numbered from rendered order, never from a name, because a
       * translated accessible name is a label. This is the term that keeps
       * three same-shaped singleton rows (Settings, Help, Archive) apart.
       */
      const familyInstanceIndexes = new Map<Element, number>();
      {
        const familyCounters = new Map<string, number>();
        for (const element of allElements) {
          if (element.children.length === 0 || !isRendered(element)) continue;
          const key = `${sectionScopeOf(element) ?? ''}|${rowStructureFamily(element)}`;
          const nextIndex = familyCounters.get(key) ?? 0;
          familyInstanceIndexes.set(element, nextIndex);
          familyCounters.set(key, nextIndex + 1);
        }
      }
      const elementsWithRole = (row: Element, role: string) =>
        [row, ...row.querySelectorAll<Element>('*')].filter(
          (candidate) =>
            nativeRole(candidate) === role &&
            (role !== 'text' || hasDirectText(candidate)) &&
            isRendered(candidate)
        );
      const controlSelector =
        'button, [role="button"], a[href], [role="link"], input, select, textarea, [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"]';
      // Every role that names itself from its own content owns the locator for
      // the primitives inside it, so a tab's label reports as the tab.
      const locatorOwnerOf = (element: Element) => {
        const labelledControl = element.closest<Element>(controlSelector);
        return accessibleName(element) || !labelledControl ? element : labelledControl;
      };
      /**
       * Display-only naming evidence: what the owner's own text is once its
       * nested controls are removed, and the row title a repeated row shows.
       */
      const candidateNaming = (element: Element) => {
        const owner = locatorOwnerOf(element);
        const nestedControlNames = [
          ...new Set(
            Array.from(owner.querySelectorAll<Element>(controlSelector))
              .filter((control) => control !== owner && isRendered(control))
              .map((control) => accessibleName(control))
              .filter((name) => name !== '')
          ),
        ];
        const rowTitle = [owner, ...owner.querySelectorAll<Element>('*')]
          .filter((node) => node === owner || node.closest(controlSelector) === owner)
          .map((node) => directText(node))
          .filter((text) => text !== '')
          .sort((left, right) => right.length - left.length)[0];
        return {
          ...(nestedControlNames.length > 0 ? { nestedControlNames } : {}),
          ...(rowTitle ? { rowTitle: rowTitle.slice(0, 60) } : {}),
        };
      };
      const stableLocator = (element: Element, row?: Element | null): GeometryStableLocator => {
        const locatorOwner = locatorOwnerOf(element);
        let landmark: Element | null = locatorOwner.parentElement;
        while (
          landmark &&
          !landmark.matches(
            'main, aside, nav, section, header, footer, [role="main"], [role="complementary"], [role="navigation"], [role="region"]'
          )
        ) {
          landmark = landmark.parentElement;
        }
        const rowOwner =
          row && (row === locatorOwner || row.contains(locatorOwner))
            ? row
            : locatorOwner.parentElement;
        const role = nativeRole(locatorOwner);
        const rowFamily = rowOwner ? rowStructureFamily(rowOwner) : '';
        const familyIndex = rowOwner ? familyInstanceIndexes.get(rowOwner) : undefined;
        const roleIndex = rowOwner ? elementsWithRole(rowOwner, role).indexOf(locatorOwner) : -1;
        const name = accessibleName(locatorOwner);
        const landmarkName = landmark ? accessibleName(landmark) : '';
        return {
          role,
          ...(name ? { name } : {}),
          ...(landmark
            ? {
                landmark: {
                  role: nativeRole(landmark),
                  ...(landmarkName ? { name: landmarkName } : {}),
                },
              }
            : {}),
          ...(rowFamily ? { rowFamily } : {}),
          ...(familyIndex === undefined ? {} : { familyIndex }),
          ...(roleIndex >= 0 ? { roleIndex } : {}),
        };
      };
      const locatorLabel = (locator: GeometryStableLocator) =>
        `${locator.landmark ? `${locator.landmark.role}:${locator.landmark.name ?? ''}>` : ''}${
          locator.rowName ? `row:${locator.rowName}>` : ''
        }${locator.rowFamily ? `row-family:${locator.rowFamily}>` : ''}${locator.role}:${
          locator.name ?? ''
        }${locator.roleIndex === undefined ? '' : `#${locator.roleIndex}`}`;
      const isDiscoveryExcluded = (element: Element) => {
        const owner = element.closest<Element>(`[${discoveryAttribute}]`);
        return owner
          ? excludedScopes.includes(owner.getAttribute(discoveryAttribute) ?? '')
          : false;
      };
      const measureDirectText = (element: Element) => {
        return measureGeometryElement(element, 'ink');
      };
      const measureSvgInk = (element: Element) => {
        return measureGeometryElement(element, 'ink');
      };
      const isCenteredText = (element: Element, boundary: Element) => {
        const rect = element.getBoundingClientRect();
        for (let owner: Element | null = element; owner; owner = owner.parentElement) {
          const style = getComputedStyle(owner);
          if (style.textAlign === 'center') return true;
          const parent = owner.parentElement;
          if (!parent) break;
          const parentStyle = getComputedStyle(parent);
          const parentRect = parent.getBoundingClientRect();
          if (
            (parentStyle.display.includes('flex') || parentStyle.display.includes('grid')) &&
            (parentStyle.justifyContent === 'center' || parentStyle.justifyItems === 'center') &&
            Math.abs(rect.x + rect.width / 2 - (parentRect.x + parentRect.width / 2)) <= 1
          ) {
            return true;
          }
          if (owner === boundary) break;
        }
        return false;
      };
      const primitiveLabel = (element: Element, boundary: Element) => {
        const text = directText(element);
        if (text) return text.slice(0, 48);
        for (let owner: Element | null = element; owner; owner = owner.parentElement) {
          const label =
            owner.getAttribute('aria-label') ??
            owner.getAttribute('data-id') ??
            owner.getAttribute('title');
          if (label?.trim()) return label.trim().slice(0, 48);
          if (owner === boundary) break;
        }
        return element.tagName.toLowerCase();
      };
      const isPaintedShape = (element: Element) => {
        // Ordered by cost. This runs for every rendered element of every scope,
        // and a computed style — one per CHILD, in the first version of this —
        // forces a style recalculation every time. The cheap structural tests
        // reject almost everything before that happens.
        if (element.children.length > 0) return false;
        if ((element.textContent ?? '').trim() !== '') return false;
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0) || rect.width > 24 || rect.height > 24) {
          return false;
        }
        const style = getComputedStyle(element);
        return isPaintedShapeStyle({
          width: rect.width,
          height: rect.height,
          renderedChildCount: 0,
          text: '',
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderWidths: [
            Number.parseFloat(style.borderTopWidth) || 0,
            Number.parseFloat(style.borderRightWidth) || 0,
            Number.parseFloat(style.borderBottomWidth) || 0,
            Number.parseFloat(style.borderLeftWidth) || 0,
          ],
          borderColors: [
            style.borderTopColor,
            style.borderRightColor,
            style.borderBottomColor,
            style.borderLeftColor,
          ],
        });
      };
      const directVisualPrimitive = (
        element: Element,
        boundary: Element
      ): VisualPrimitive | null => {
        // A form control FIRST. A `<textarea>` carries its default value as a
        // child text node that never renders, so the text branch would measure
        // it as a text primitive whose ink is really its 48px layout box — and
        // then compare that box's centre against the draft text inside it.
        if (element.matches('input, select, textarea')) {
          const fieldRect = plainRect(element.getBoundingClientRect());
          if (fieldRect.width <= 0 || fieldRect.height <= 0) return null;
          return {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: primitiveLabel(element, boundary),
            kind: 'field',
            space: 'layout-box',
            rect: fieldRect,
          };
        }
        const text = directText(element);
        if (text) {
          const rect = measureDirectText(element);
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: text.slice(0, 48),
            kind: /^[+\-\u2212\d\s]+$/.test(text) ? 'numeric-text' : 'text',
            alignmentMode: isCenteredText(element, boundary) ? 'centered' : 'flow',
            space: 'ink',
            rect,
          };
        }
        if (element.matches('svg')) {
          const rect = measureSvgInk(element);
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: primitiveLabel(element, boundary),
            kind: 'svg',
            space: 'ink',
            rect,
          };
        }
        if (element.matches('img')) {
          const rect = plainRect(element.getBoundingClientRect());
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: primitiveLabel(element, boundary),
            kind: 'image',
            space: 'ink',
            rect,
          };
        }
        // A painted CSS shape — a status dot, a pip, a rule — is ink a reader
        // aligns against just like an icon, but it owns no glyph, no path and
        // no image, so every other branch above is blind to it. Its border box
        // IS its ink: there is nothing inside it to measure.
        if (isPaintedShape(element)) {
          const rect = plainRect(element.getBoundingClientRect());
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: primitiveLabel(element, boundary),
            kind: 'shape',
            space: 'ink',
            rect,
          };
        }
        return null;
      };
      const visualPrimitivesWithin = (element: Element): readonly VisualPrimitive[] => {
        const descendants = [element, ...element.querySelectorAll<Element>('*')].filter(
          (candidate) => isRendered(candidate)
        );
        const primitives = descendants.flatMap((candidate) => {
          const primitive = directVisualPrimitive(candidate, element);
          return primitive ? [primitive] : [];
        });
        if (primitives.length > 0) return primitives;
        if (!element.matches('button, [role="button"], a')) return [];
        const rect = plainRect(element.getBoundingClientRect());
        if (rect.width <= 0 || rect.height <= 0) return [];
        return [
          {
            element,
            primitiveId: idByElement.get(element) ?? 'dom-unknown',
            locator: stableLocator(element),
            label: primitiveLabel(element, element),
            kind: element.matches('a') ? 'link' : 'button',
            space: 'layout-box',
            rect,
          },
        ];
      };
      const visualPrimitiveForElement = (
        element: Element,
        boundary: Element
      ): VisualPrimitive | null => {
        const direct = directVisualPrimitive(element, boundary);
        if (direct) return direct;
        if (!element.matches('button, [role="button"], a')) return null;
        const hasVisualDescendant = Array.from(element.querySelectorAll<Element>('*')).some(
          (descendant) =>
            isRendered(descendant) && directVisualPrimitive(descendant, element) !== null
        );
        if (hasVisualDescendant) return null;
        return visualPrimitivesWithin(element)[0] ?? null;
      };
      const elementDepth = (element: Element) => {
        let depth = 0;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          depth += 1;
        }
        return depth;
      };
      const blockAnchorsOf = (
        element: Element,
        kind: string,
        rect: Readonly<{ y: number; height: number }>
      ) => measureBlockAnchors(element, kind, rect.y, rect.height);
      const sectionIdentity = (element: Element, scopeElement: Element) => {
        const nestedScope = element.closest<Element>(`[${discoveryAttribute}]`);
        if (nestedScope && nestedScope !== scopeElement) {
          return `scope:${nestedScope.getAttribute(discoveryAttribute) ?? ''}`;
        }
        let section = element;
        while (section.parentElement && section.parentElement !== scopeElement) {
          section = section.parentElement;
        }
        const sectionIndex = Array.from(scopeElement.children).indexOf(section);
        return `section:${sectionIndex}:${rowStructureFamily(section)}`;
      };

      const scopeSnapshot = (
        scopeElement: Element,
        scope: string,
        aggregateNestedScopes: boolean,
        honorNestedScopeBoundaries: boolean
      ) => {
        const scopeRect = scopeElement.getBoundingClientRect();
        const belongsToScope = (element: Element) =>
          aggregateNestedScopes ||
          !honorNestedScopeBoundaries ||
          element.closest(`[${discoveryAttribute}]`) === scopeElement;
        const elements = [scopeElement, ...scopeElement.querySelectorAll<Element>('*')].filter(
          (element) =>
            belongsToScope(element) &&
            !isDiscoveryExcluded(element) &&
            !element.closest('[data-geometry-devtool]') &&
            isRendered(element)
        );

        const rowProposals = elements.flatMap((element) => {
          const rect = element.getBoundingClientRect();
          if (
            rect.height < 16 ||
            rect.height > 48 ||
            rect.width < Math.min(120, scopeRect.width * 0.55)
          ) {
            return [];
          }
          const candidateSlots = Array.from(element.children).filter((child) => {
            const childRect = child.getBoundingClientRect();
            const childCenter = childRect.top + childRect.height / 2;
            return (
              belongsToScope(child) &&
              isRendered(child) &&
              childRect.width > 0 &&
              childRect.height > 0 &&
              childCenter >= rect.top - 1 &&
              childCenter <= rect.bottom + 1
            );
          });
          if (candidateSlots.length < 2) return [];
          // A row is a line, not a stack: every member has to sit on the row
          // band. A composer's `label` above its textarea otherwise becomes a
          // "row" whose two lines report their leading as a misalignment.
          const onRow = new Set(
            selectRowSlots(
              candidateSlots.map((slot) => {
                const slotRect = slot.getBoundingClientRect();
                return { top: slotRect.top, bottom: slotRect.bottom };
              }),
              rect.top + rect.height / 2
            )
          );
          const slots = candidateSlots.filter((_slot, index) => onRow.has(index));
          if (slots.length < 2) return [];
          const slotLeft = Math.min(...slots.map((slot) => slot.getBoundingClientRect().left));
          const slotRight = Math.max(...slots.map((slot) => slot.getBoundingClientRect().right));
          const slotSpan = slotRight - slotLeft;
          if (slotSpan / rect.width < 0.72) return [];
          return [{ element, rect, slots, slotSpan, depth: elementDepth(element) }];
        });

        const rows = rowProposals
          .sort(
            (left, right) =>
              left.rect.top - right.rect.top ||
              right.slotSpan - left.slotSpan ||
              right.depth - left.depth
          )
          .filter((proposal, index, proposals) => {
            const center = proposal.rect.top + proposal.rect.height / 2;
            return !proposals.slice(0, index).some((existing) => {
              const existingCenter = existing.rect.top + existing.rect.height / 2;
              const horizontalOverlap =
                Math.max(
                  0,
                  Math.min(proposal.rect.right, existing.rect.right) -
                    Math.max(proposal.rect.left, existing.rect.left)
                ) / Math.min(proposal.rect.width, existing.rect.width);
              return Math.abs(center - existingCenter) <= 1 && horizontalOverlap >= 0.5;
            });
          });

        const blockCandidates: BrowserCapturedBlockCandidate[] = [];
        const candidates: BrowserCapturedCandidate[] = rows.flatMap((row, rowIndex) => {
          const rowCenter = row.rect.top + row.rect.height / 2;
          return row.slots.flatMap((slot, slotIndex) => {
            return visualPrimitivesWithin(slot).flatMap((primitive, primitiveIndex) => {
              const { rect } = primitive;
              const locator = stableLocator(primitive.element, row.element);
              const naming = candidateNaming(primitive.element);
              const elementId = `${rowIndex + 1}.${slotIndex + 1}.${primitiveIndex + 1}:${
                primitive.label
              }`;
              const sectionScope = sectionScopeOf(primitive.element);
              const path = boxModelPath(primitive.element, document.body);
              const rowId = `visual-row:${Number(rowCenter.toFixed(1))}:${Number(
                row.rect.x.toFixed(1)
              )}`;
              const common = {
                elementId: locatorLabel(locator) || elementId,
                primitiveId: primitive.primitiveId,
                locator,
                label: primitive.label,
                naming,
                ...(sectionScope ? { sectionScope } : {}),
                boxModelPath: path,
                rowId,
                rowFamily: rowStructureFamily(row.element),
                sectionId: sectionIdentity(row.element, scopeElement),
                kind: primitive.kind,
                ...(primitive.alignmentMode ? { alignmentMode: primitive.alignmentMode } : {}),
                space: primitive.space,
                yStart: rect.y,
                yEnd: rect.y + rect.height,
              };
              const anchors = blockAnchorsOf(primitive.element, primitive.kind, rect);
              // Unlike the X elementId, this one must separate two primitives of
              // ONE row: a row's icon and its label share a locator owner, and a
              // Y rail compares exactly those two against each other.
              const blockCommon = {
                ...common,
                elementId: `${primitive.primitiveId}:${primitive.label}`,
                xStart: rect.x,
                xEnd: rect.x + rect.width,
                ...(anchors.typographyOffset === 0
                  ? {}
                  : { typographyOffset: anchors.typographyOffset }),
              };
              blockCandidates.push(
                { ...blockCommon, anchor: 'block-start' as const, coordinate: anchors.blockStart },
                {
                  ...blockCommon,
                  anchor: 'block-center' as const,
                  coordinate: anchors.blockCenter,
                },
                { ...blockCommon, anchor: 'block-end' as const, coordinate: anchors.blockEnd },
                {
                  ...blockCommon,
                  anchor: 'visual-center' as const,
                  coordinate: anchors.visualCenter,
                },
                ...(anchors.textBaseline === null
                  ? []
                  : [
                      {
                        ...blockCommon,
                        anchor: 'text-baseline' as const,
                        coordinate: anchors.textBaseline,
                      },
                    ])
              );
              return [
                { ...common, anchor: 'inline-start' as const, coordinate: rect.x },
                {
                  ...common,
                  anchor: 'inline-center' as const,
                  coordinate: rect.x + rect.width / 2,
                },
                {
                  ...common,
                  anchor: 'inline-end' as const,
                  coordinate: rect.x + rect.width,
                },
              ];
            });
          });
        });

        const atomsOutsideRows = elements.flatMap((element) => {
          if (element === scopeElement) return [];
          const primitive = directVisualPrimitive(element, scopeElement);
          if (!primitive) return [];
          const center = primitive.rect.y + primitive.rect.height / 2;
          const belongsToVisualRow = rows.some((row) => {
            const rowCenter = row.rect.top + row.rect.height / 2;
            const primitiveRight = primitive.rect.x + primitive.rect.width;
            const overlapsRow =
              primitiveRight >= row.rect.left && primitive.rect.x <= row.rect.right;
            return (
              row.element.contains(element) ||
              element.contains(row.element) ||
              (Math.abs(center - rowCenter) <= 1 && overlapsRow)
            );
          });
          return belongsToVisualRow ? [] : [primitive];
        });
        candidates.push(
          ...atomsOutsideRows.flatMap((primitive, index) => {
            const { rect } = primitive;
            const rowOwner = primitive.element.parentElement;
            const locator = stableLocator(primitive.element, rowOwner);
            const atomSectionScope = sectionScopeOf(primitive.element);
            const common = {
              elementId: locatorLabel(locator) || `${index + 1}:${primitive.label}`,
              primitiveId: primitive.primitiveId,
              locator,
              label: primitive.label,
              naming: candidateNaming(primitive.element),
              ...(atomSectionScope ? { sectionScope: atomSectionScope } : {}),
              boxModelPath: boxModelPath(primitive.element, document.body),
              rowId: `visual-row:${Number((rect.y + rect.height / 2).toFixed(1))}:${Number(
                rect.x.toFixed(1)
              )}`,
              ...(rowOwner ? { rowFamily: rowStructureFamily(rowOwner) } : {}),
              sectionId: sectionIdentity(primitive.element, scopeElement),
              kind: primitive.kind,
              ...(primitive.alignmentMode ? { alignmentMode: primitive.alignmentMode } : {}),
              space: primitive.space,
              yStart: rect.y,
              yEnd: rect.y + rect.height,
            };
            // An atom is measured on the Y axis too. A row REJECTED it, and a
            // rejected slot is still an atom: leaving it out here is the DOM row
            // acting as an eligibility test one layer before discovery, so a
            // control rendering outside every detected row could not be compared
            // to anything vertically no matter what the rules downstream said.
            // Its `rowId` is its own, so it can never reach the two-member
            // row-instance bar by itself; a geometric row is what may group it.
            const atomAnchors = blockAnchorsOf(primitive.element, primitive.kind, rect);
            const atomBlockCommon = {
              ...common,
              // Its OWN row, named after the primitive rather than after its
              // coordinates. Two atoms whose centre and left edge happen to
              // round alike would otherwise share the coordinate-derived row id
              // and be compared at the two-member bar — the one place a single
              // capture is evidence enough — on a coincidence rather than on
              // any structure relating them.
              rowId: `visual-atom:${primitive.primitiveId}`,
              elementId: `${primitive.primitiveId}:${primitive.label}`,
              xStart: rect.x,
              xEnd: rect.x + rect.width,
              ...(atomAnchors.typographyOffset === 0
                ? {}
                : { typographyOffset: atomAnchors.typographyOffset }),
            };
            blockCandidates.push(
              {
                ...atomBlockCommon,
                anchor: 'block-start' as const,
                coordinate: atomAnchors.blockStart,
              },
              {
                ...atomBlockCommon,
                anchor: 'block-center' as const,
                coordinate: atomAnchors.blockCenter,
              },
              {
                ...atomBlockCommon,
                anchor: 'block-end' as const,
                coordinate: atomAnchors.blockEnd,
              },
              {
                ...atomBlockCommon,
                anchor: 'visual-center' as const,
                coordinate: atomAnchors.visualCenter,
              },
              ...(atomAnchors.textBaseline === null
                ? []
                : [
                    {
                      ...atomBlockCommon,
                      anchor: 'text-baseline' as const,
                      coordinate: atomAnchors.textBaseline,
                    },
                  ])
            );
            return [
              { ...common, anchor: 'inline-start' as const, coordinate: rect.x },
              {
                ...common,
                anchor: 'inline-center' as const,
                coordinate: rect.x + rect.width / 2,
              },
              {
                ...common,
                anchor: 'inline-end' as const,
                coordinate: rect.x + rect.width,
              },
            ];
          })
        );

        return {
          scope,
          identity: `hint:${scope}`,
          depth: elementDepth(scopeElement),
          rect: {
            x: scopeRect.x,
            y: scopeRect.y,
            width: scopeRect.width,
            height: scopeRect.height,
          },
          rowCount: rows.length,
          candidates,
          blockCandidates,
        };
      };

      const manualScopes = Array.from(document.querySelectorAll<Element>(`[${discoveryAttribute}]`))
        .filter((scopeElement) => !isDiscoveryExcluded(scopeElement))
        .map((scopeElement) => {
          const scope = scopeElement.getAttribute(discoveryAttribute) ?? 'unnamed';
          return scopeSnapshot(scopeElement, scope, aggregateScopes.includes(scope), true);
        });

      const regionScopes = Array.from(
        document.body.querySelectorAll<Element>('aside, main, nav, section, div, ul, ol')
      )
        .filter((element) => {
          if (
            element.closest('[data-geometry-devtool]') ||
            isDiscoveryExcluded(element) ||
            !isRendered(element)
          )
            return false;
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= 120 &&
            rect.height >= 80 &&
            element.querySelectorAll('button, [role="button"], a, input, select, textarea')
              .length >= 3
          );
        })
        .map((scopeElement, index) =>
          scopeSnapshot(scopeElement, `auto-region:${index + 1}`, true, false)
        )
        .filter((scope) => scope.rowCount >= 3)
        .sort(
          (left, right) =>
            right.rowCount - left.rowCount ||
            left.rect.width * left.rect.height - right.rect.width * right.rect.height
        )
        .filter(
          (scope, index, scopes) =>
            !scopes
              .slice(0, index)
              .some(
                (existing) =>
                  Math.abs(existing.rect.x - scope.rect.x) <= 1 &&
                  Math.abs(existing.rect.y - scope.rect.y) <= 1 &&
                  Math.abs(existing.rect.width - scope.rect.width) <= 1 &&
                  Math.abs(existing.rect.height - scope.rect.height) <= 1
              )
        )
        .slice(0, 12);

      const topologyElements = Array.from(document.body.querySelectorAll<Element>('*')).filter(
        (element) =>
          !element.closest('[data-geometry-devtool]') &&
          !isDiscoveryExcluded(element) &&
          isRendered(element)
      );
      const topologyNodes = topologyElements.map((element, index) => {
        const rect = element.getBoundingClientRect();
        const primitive = visualPrimitiveForElement(element, document.body);
        let parent = element.parentElement;
        while (parent && !idByElement.has(parent)) parent = parent.parentElement;
        let depth = 0;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          depth += 1;
        }
        return {
          id: idByElement.get(element) ?? `dom-${index + 1}`,
          parentId: parent ? (idByElement.get(parent) ?? null) : null,
          order: element.parentElement
            ? Array.prototype.indexOf.call(element.parentElement.children, element)
            : index,
          depth,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          candidateKind: candidateKind(element),
          elementId: primitive ? locatorLabel(primitive.locator) : null,
          primitive: primitive
            ? {
                primitiveId: primitive.primitiveId,
                locator: primitive.locator,
                label: primitive.label,
                naming: candidateNaming(primitive.element),
                ...(sectionScopeOf(primitive.element)
                  ? { sectionScope: sectionScopeOf(primitive.element) }
                  : {}),
                kind: primitive.kind,
                ...(primitive.alignmentMode ? { alignmentMode: primitive.alignmentMode } : {}),
                space: primitive.space,
                rect: primitive.rect,
                blockAnchors: blockAnchorsOf(primitive.element, primitive.kind, primitive.rect),
                boxModelPath: boxModelPath(primitive.element, document.body),
              }
            : null,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      });

      return { manualScopes, regionScopes, topologyNodes };
    },
    {
      discoveryAttribute: CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
      aggregateScopes: [...(options.aggregateScopes ?? [])],
      excludedScopes: [...(options.excludedScopes ?? ['session.messages'])],
    }
  );

  type BrowserCapturedCandidate = GeometryCapturedCandidate &
    Readonly<{ boxModelPath: readonly GeometryBoxModelPathStep[] }>;
  type BrowserCapturedBlockCandidate = GeometryCapturedBlockCandidate &
    Readonly<{ boxModelPath: readonly GeometryBoxModelPathStep[] }>;
  const compactCandidates = (
    rawCandidates: readonly BrowserCapturedCandidate[],
    rawBlockCandidates: readonly BrowserCapturedBlockCandidate[] = []
  ) => {
    const boxModelNodes: Record<string, GeometryBoxModelPathStep> = {};
    const candidates = rawCandidates.map((rawCandidate): GeometryCapturedCandidate => {
      const { boxModelPath, ...candidate } = rawCandidate;
      for (const node of boxModelPath) boxModelNodes[node.nodeId] = node;
      return { ...candidate, boxModelNodeRef: boxModelPath[0]?.nodeId };
    });
    const blockCandidates = rawBlockCandidates.map(
      (rawCandidate): GeometryCapturedBlockCandidate => {
        const { boxModelPath, ...candidate } = rawCandidate;
        for (const node of boxModelPath) boxModelNodes[node.nodeId] = node;
        return { ...candidate, boxModelNodeRef: boxModelPath[0]?.nodeId };
      }
    );
    return {
      candidates,
      ...(blockCandidates.length > 0 ? { blockCandidates } : {}),
      boxModelNodes,
    };
  };
  const manualScopes: GeometryCapturedScope[] = snapshot.manualScopes.map(
    ({ scope, identity, depth, rect, candidates, blockCandidates }) => {
      const compacted = compactCandidates(candidates, blockCandidates);
      return {
        key: scope,
        identity,
        source: 'hint',
        depth,
        rect,
        ...compacted,
      };
    }
  );

  const overlapShare = (left: GeometryRect, right: GeometryRect) => {
    const width = Math.max(
      0,
      Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
    );
    const height = Math.max(
      0,
      Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
    );
    return (width * height) / Math.min(left.width * left.height, right.width * right.height);
  };
  const regionScopes: GeometryCapturedScope[] = snapshot.regionScopes
    .filter(
      ({ rect }) => !manualScopes.some((manualScope) => overlapShare(rect, manualScope.rect) >= 0.8)
    )
    .map(({ scope, depth, rect, rowCount, candidates, blockCandidates }) => {
      const compacted = compactCandidates(candidates, blockCandidates);
      return {
        key: scope,
        identity: 'auto-region:geometry-region',
        source: 'auto' as const,
        depth,
        rect,
        ...compacted,
        topology: {
          signature: 'geometry-region',
          instanceCount: rowCount,
          confidence: Math.min(1, rowCount / 6),
        },
      };
    });

  type BrowserTopologyNode = LayoutTopologyNode &
    Readonly<{
      elementId: string | null;
      primitive: Readonly<{
        primitiveId: string;
        locator: GeometryStableLocator;
        label: string;
        naming?: GeometryCandidateNaming;
        sectionScope?: string;
        kind: string;
        alignmentMode?: 'flow' | 'centered';
        space: 'ink' | 'layout-box';
        rect: GeometryRect;
        blockAnchors: ReturnType<typeof measureGeometryBlockAnchorsInBrowser>;
        boxModelPath: readonly GeometryBoxModelPathStep[];
      }> | null;
    }>;
  const topologyNodes = snapshot.topologyNodes as readonly BrowserTopologyNode[];
  const topologyById = new Map(topologyNodes.map((node) => [node.id, node]));
  const autoScopes = discoverRepeatedLayoutScopes(topologyNodes).map(
    (autoScope): GeometryCapturedScope => {
      const instanceIds = new Set(autoScope.instanceIds);
      const boxModelNodes: Record<string, GeometryBoxModelPathStep> = {};
      const blockCandidates: GeometryCapturedBlockCandidate[] = [];
      const candidates = topologyNodes.flatMap((node): readonly GeometryCapturedCandidate[] => {
        if (
          !node.elementId ||
          !node.primitive ||
          node.primitive.rect.width <= 0 ||
          node.primitive.rect.height <= 0
        ) {
          return [];
        }
        let ancestor: BrowserTopologyNode | undefined = node;
        while (ancestor && !instanceIds.has(ancestor.id)) {
          ancestor = ancestor.parentId ? topologyById.get(ancestor.parentId) : undefined;
        }
        if (!ancestor) return [];
        const { rect } = node.primitive;
        for (const boxModelNode of node.primitive.boxModelPath) {
          boxModelNodes[boxModelNode.nodeId] = boxModelNode;
        }
        const yStart = rect.y;
        const yEnd = rect.y + rect.height;
        const anchors = node.primitive.blockAnchors;
        const blockCommon = {
          elementId: `${node.primitive.primitiveId}:${node.primitive.label}`,
          primitiveId: node.primitive.primitiveId,
          locator: node.primitive.locator,
          label: node.primitive.label,
          ...(node.primitive.naming ? { naming: node.primitive.naming } : {}),
          ...(node.primitive.sectionScope ? { sectionScope: node.primitive.sectionScope } : {}),
          boxModelNodeRef: node.primitive.boxModelPath[0]?.nodeId,
          rowId: `${autoScope.id}:${ancestor.id}`,
          ...(node.primitive.locator.rowFamily
            ? { rowFamily: node.primitive.locator.rowFamily }
            : {}),
          sectionId: `auto:${autoScope.signature}`,
          kind: node.primitive.kind,
          space: node.primitive.space,
          xStart: rect.x,
          xEnd: rect.x + rect.width,
          yStart,
          yEnd,
          ...(anchors.typographyOffset === 0 ? {} : { typographyOffset: anchors.typographyOffset }),
        };
        blockCandidates.push(
          { ...blockCommon, anchor: 'block-start', coordinate: anchors.blockStart },
          { ...blockCommon, anchor: 'block-center', coordinate: anchors.blockCenter },
          { ...blockCommon, anchor: 'block-end', coordinate: anchors.blockEnd },
          { ...blockCommon, anchor: 'visual-center', coordinate: anchors.visualCenter },
          ...(anchors.textBaseline === null
            ? []
            : [
                {
                  ...blockCommon,
                  anchor: 'text-baseline' as const,
                  coordinate: anchors.textBaseline,
                },
              ])
        );
        return [
          {
            elementId: node.elementId,
            primitiveId: node.primitive.primitiveId,
            locator: node.primitive.locator,
            label: node.primitive.label,
            ...(node.primitive.naming ? { naming: node.primitive.naming } : {}),
            ...(node.primitive.sectionScope ? { sectionScope: node.primitive.sectionScope } : {}),
            boxModelNodeRef: node.primitive.boxModelPath[0]?.nodeId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            rowFamily: node.primitive.locator.rowFamily,
            sectionId: `auto:${autoScope.signature}`,
            kind: node.primitive.kind,
            ...(node.primitive.alignmentMode
              ? { alignmentMode: node.primitive.alignmentMode }
              : {}),
            space: node.primitive.space,
            anchor: 'inline-start',
            coordinate: rect.x,
            yStart,
            yEnd,
          },
          {
            elementId: node.elementId,
            primitiveId: node.primitive.primitiveId,
            locator: node.primitive.locator,
            label: node.primitive.label,
            ...(node.primitive.naming ? { naming: node.primitive.naming } : {}),
            ...(node.primitive.sectionScope ? { sectionScope: node.primitive.sectionScope } : {}),
            boxModelNodeRef: node.primitive.boxModelPath[0]?.nodeId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            rowFamily: node.primitive.locator.rowFamily,
            sectionId: `auto:${autoScope.signature}`,
            kind: node.primitive.kind,
            ...(node.primitive.alignmentMode
              ? { alignmentMode: node.primitive.alignmentMode }
              : {}),
            space: node.primitive.space,
            anchor: 'inline-center',
            coordinate: rect.x + rect.width / 2,
            yStart,
            yEnd,
          },
          {
            elementId: node.elementId,
            primitiveId: node.primitive.primitiveId,
            locator: node.primitive.locator,
            label: node.primitive.label,
            ...(node.primitive.naming ? { naming: node.primitive.naming } : {}),
            ...(node.primitive.sectionScope ? { sectionScope: node.primitive.sectionScope } : {}),
            boxModelNodeRef: node.primitive.boxModelPath[0]?.nodeId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            rowFamily: node.primitive.locator.rowFamily,
            sectionId: `auto:${autoScope.signature}`,
            kind: node.primitive.kind,
            ...(node.primitive.alignmentMode
              ? { alignmentMode: node.primitive.alignmentMode }
              : {}),
            space: node.primitive.space,
            anchor: 'inline-end',
            coordinate: rect.x + rect.width,
            yStart,
            yEnd,
          },
        ];
      });
      return {
        key: autoScope.id,
        identity: `auto:${autoScope.signature}`,
        source: 'auto',
        depth: topologyById.get(autoScope.parentId)?.depth ?? 0,
        rect: autoScope.rect,
        candidates,
        ...(blockCandidates.length > 0 ? { blockCandidates } : {}),
        boxModelNodes,
        topology: {
          signature: autoScope.signature,
          instanceCount: autoScope.instanceIds.length,
          confidence: autoScope.confidence,
        },
      };
    }
  );

  return [...manualScopes, ...regionScopes, ...autoScopes];
}

export async function discoverChatWorkspaceAlignmentRails(
  page: Page,
  options: ChatWorkspaceGeometryCaptureOptions &
    Readonly<{
      captureId?: string;
      surfaceFamily?: GeometrySurfaceFamily;
      observationCache?: GeometryObservationCache;
    }> = {}
): Promise<readonly BrowserAlignmentRailDiscoveryScope[]> {
  const scopes = await captureChatWorkspaceGeometryScopes(page, options);
  const captureId = options.captureId ?? 'browser-capture';
  const surfaceFamily = options.surfaceFamily ?? 'workspace';
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
  const artifact = observeGeometryCaptures(
    {
      version: 1,
      captures: [
        {
          captureId,
          surfaceFamily,
          surface: surfaceFamily,
          storyId: 'browser',
          viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          deviceScaleFactor,
          screenshot: '',
          scopes,
        },
      ],
    },
    { cache: options.observationCache }
  );
  const byIdentity = new Map(scopes.map((scope) => [scope.key, scope]));
  const cachedScopes = options.observationCache ? [...options.observationCache.values()] : [];
  return (artifact.captures[0]?.scopes ?? []).map((rawObservation) => {
    const observed = rawObservation.observationRef
      ? materializeGeometryObservationScope(rawObservation, [rawObservation, ...cachedScopes])
      : rawObservation;
    const captured = byIdentity.get(observed.scopeKey);
    if (!captured) throw new Error(`Missing captured geometry scope: ${observed.scopeKey}`);
    return {
      scope: observed.scopeKey,
      identity: observed.scopeIdentity,
      source: captured.source,
      depth: captured.depth,
      rect: observed.scopeRect,
      contentHash: observed.contentHash,
      capturedScope: captured,
      ...(rawObservation.observationRef
        ? { reusedFromCaptureId: rawObservation.observationRef.captureId }
        : {}),
      candidateCount: observed.candidateCount,
      rails: observed.rails ?? [],
      railFamilies: observed.railFamilies ?? [],
      ...(captured.topology ? { topology: captured.topology } : {}),
    };
  });
}

/**
 * The Y half of discovery, for callers that need the rails themselves rather
 * than the per-scope X view: Y rails are per visual ROW and observed once per
 * capture, so they do not belong to any one discovery scope.
 */
export async function discoverChatWorkspaceBlockRails(
  page: Page,
  options: ChatWorkspaceGeometryCaptureOptions &
    Readonly<{ captureId?: string; surfaceFamily?: GeometrySurfaceFamily }> = {}
): Promise<readonly DiscoveredBlockRail[]> {
  const scopes = await captureChatWorkspaceGeometryScopes(page, options);
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
  const artifact = observeGeometryCaptures({
    version: 1,
    captures: [
      {
        captureId: options.captureId ?? 'browser-capture',
        surfaceFamily: options.surfaceFamily ?? 'workspace',
        surface: options.surfaceFamily ?? 'workspace',
        storyId: 'browser',
        viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
        deviceScaleFactor,
        screenshot: '',
        scopes,
      },
    ],
  });
  return artifact.captures[0]?.blockRails ?? [];
}

/** ARIA roles the gate may cross-check through Playwright's own role engine. */
const PLAYWRIGHT_CHECKABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'heading',
  'img',
  'link',
  'listitem',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

export type GeometryContractMemberMeasurement = Readonly<{
  description: string;
  ink: GeometryRect;
  box: GeometryRect;
  /** Sum of the requested computed properties, or null when one is not a length. */
  propertyValue: number | null;
  /** Each requested property on its own, so a failure can name the exact terms. */
  propertyValues: Readonly<Record<string, number | null>>;
  containsSvg: boolean;
  nameMatchCount: number;
}>;

/**
 * Resolve a stable locator with exactly the rules capture used — `nativeRole`,
 * the shared accessible name, the row-structure family, the same-role index —
 * and measure the matches in one page call. A relation may read more than one
 * computed property; the member value is then their sum.
 */
export async function resolveGeometryContractMembers(
  page: Page,
  member: GeometryStableLocator,
  properties: readonly string[] | null
): Promise<readonly GeometryContractMemberMeasurement[]> {
  return page.evaluate(
    ({ expected, computedProperties }) => {
      const measureGeometryElement = (
        globalThis as typeof globalThis & {
          __lodyMeasureGeometryElement?: typeof measureGeometryElementInBrowser;
        }
      ).__lodyMeasureGeometryElement;
      const accessibleName = (
        globalThis as typeof globalThis & {
          __lodyAccessibleName?: typeof computeAccessibleNameInBrowser;
        }
      ).__lodyAccessibleName;
      if (!measureGeometryElement || !accessibleName) {
        throw new Error('Geometry browser helpers are missing');
      }
      const nativeRole = (candidate: Element) => {
        const explicit = candidate.getAttribute('role');
        if (explicit) return explicit;
        if (candidate.matches('button')) return 'button';
        if (candidate.matches('a[href]')) return 'link';
        if (candidate.matches('input, textarea')) return 'textbox';
        if (candidate.matches('select')) return 'combobox';
        if (candidate.matches('img, svg')) return 'img';
        if (candidate.matches('main')) return 'main';
        if (candidate.matches('aside')) return 'complementary';
        if (candidate.matches('nav')) return 'navigation';
        if (candidate.matches('section')) return 'region';
        if (candidate.matches('header')) return 'banner';
        if (candidate.matches('footer')) return 'contentinfo';
        return 'text';
      };
      const family = (row: Element) => {
        const token = (candidate: Element) =>
          `${candidate.tagName.toLowerCase()}[${nativeRole(candidate)}]`;
        return `${token(row)}>${Array.from(row.children).map(token).join(',')}`;
      };
      const isRendered = (candidate: Element) => {
        if (candidate.closest('[aria-hidden="true"]')) return false;
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const describe = (candidate: Element) => {
        const attributes = [
          ['role', candidate.getAttribute('role')],
          ['aria-label', candidate.getAttribute('aria-label')],
        ]
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([name, value]) => `[${name}=${value.replace(/\s+/g, ' ').slice(0, 48)}]`)
          .join('');
        return `${candidate.tagName.toLowerCase()}${attributes}`;
      };

      const all = Array.from(document.body.querySelectorAll<Element>('*')).filter(isRendered);
      const byRole = all.filter((candidate) => nativeRole(candidate) === expected.role);
      const nameMatches = expected.name
        ? byRole.filter((candidate) => accessibleName(candidate) === expected.name)
        : byRole;
      const matches = nameMatches.filter((candidate) => {
        if (expected.selfFamily && family(candidate) !== expected.selfFamily) return false;
        if (expected.rowName || expected.rowFamily || expected.roleIndex !== undefined) {
          let row: Element | null = null;
          for (let owner = candidate.parentElement; owner; owner = owner.parentElement) {
            if (expected.rowName && owner.getAttribute('aria-label') === expected.rowName) {
              row = owner;
              break;
            }
            if (expected.rowFamily && family(owner) === expected.rowFamily) {
              row = owner;
              break;
            }
          }
          if ((expected.rowName || expected.rowFamily) && !row) return false;
          if (expected.roleIndex !== undefined) {
            const owner = row ?? candidate.parentElement;
            if (!owner) return false;
            const roleMatches = [owner, ...owner.querySelectorAll<Element>('*')].filter(
              (item) => nativeRole(item) === expected.role
            );
            if (roleMatches.indexOf(candidate) !== expected.roleIndex) return false;
          }
        }
        return true;
      });

      return matches.map((candidate) => {
        const style = getComputedStyle(candidate);
        const propertyValues = Object.fromEntries(
          (computedProperties ?? []).map((property) => {
            const parsed = Number.parseFloat(style.getPropertyValue(property));
            return [property, Number.isFinite(parsed) ? parsed : null];
          })
        );
        const parsedValues = Object.values(propertyValues);
        const propertyValue =
          computedProperties && computedProperties.length > 0
            ? parsedValues.some((value) => value === null)
              ? null
              : parsedValues.reduce((total: number, value) => total + (value ?? 0), 0)
            : null;
        return {
          description: describe(candidate),
          ink: measureGeometryElement(candidate, 'ink'),
          box: measureGeometryElement(candidate, 'layout-box'),
          propertyValue,
          propertyValues,
          containsSvg: candidate.matches('svg') || candidate.querySelector('svg') !== null,
          nameMatchCount: nameMatches.length,
        };
      });
    },
    { expected: member, computedProperties: properties ? [...properties] : null }
  );
}

export type GeometryContractOpticalSample = Readonly<{
  label: string;
  description: string;
  inkCoordinate: number;
  boxCoordinate: number;
  /** Whitespace the glyph leaves inside its own layout box, in CSS pixels. */
  opticalInset: number;
  /** Centre of the member's ink, which is what a reader perceives as its position. */
  inkCenter: number;
  containsSvg: boolean;
}>;

/**
 * A layout-box contract is what the CSS decides; the ink edge is what a designer
 * sees. This records the difference per member so the two never get conflated.
 */
export async function measureGeometryContractOpticalInsets(
  page: Page,
  contract: Readonly<{
    members: readonly GeometryStableLocator[];
    anchor: SemanticAlignmentAnchor;
  }>
): Promise<readonly GeometryContractOpticalSample[]> {
  await installGeometryBrowserHelpers(page);
  const samples: GeometryContractOpticalSample[] = [];
  for (const member of contract.members) {
    const label = `${member.role}:${member.name ?? '*'}${member.all ? '[all]' : ''}`;
    const matches = await resolveGeometryContractMembers(page, member, null);
    for (const match of member.all ? matches : matches.slice(0, 1)) {
      const inkCoordinate = geometryAnchorCoordinate(match.ink, contract.anchor);
      const boxCoordinate = geometryAnchorCoordinate(match.box, contract.anchor);
      const signed =
        contract.anchor === 'inline-end' || contract.anchor === 'block-end'
          ? boxCoordinate - inkCoordinate
          : inkCoordinate - boxCoordinate;
      samples.push({
        label,
        description: match.description,
        inkCoordinate: Number(inkCoordinate.toFixed(3)),
        boxCoordinate: Number(boxCoordinate.toFixed(3)),
        opticalInset: Number(signed.toFixed(3)),
        inkCenter: Number((match.ink.x + match.ink.width / 2).toFixed(3)),
        containsSvg: match.containsSvg,
      });
    }
  }
  return samples;
}

function geometryAnchorCoordinate(rect: GeometryRect, anchor: SemanticAlignmentAnchor): number {
  if (anchor === 'inline-start') return rect.x;
  if (anchor === 'inline-center') return rect.x + rect.width / 2;
  if (anchor === 'inline-end') return rect.x + rect.width;
  if (anchor === 'block-start') return rect.y;
  if (anchor === 'block-end') return rect.y + rect.height;
  return rect.y + rect.height / 2;
}

/**
 * The gate resolves the same locators capture resolved, reads named tokens from
 * the document instead of a checked-in number, and cross-checks every named
 * member against Playwright's own role engine so the two naming models cannot
 * silently disagree.
 */
export async function validateCompiledGeometryContracts(
  page: Page,
  artifact: GeometryContractArtifact,
  storyId: string
): Promise<readonly string[]> {
  const contracts = artifact.contracts.filter((candidate) => candidate.story === storyId);
  if (contracts.length === 0) return [];
  await installGeometryBrowserHelpers(page);
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);

  const tokenNames = [
    ...new Set(
      contracts.flatMap((contract) =>
        contract.relation && contract.relation.kind !== 'coincident'
          ? [contract.relation.token]
          : []
      )
    ),
  ];
  const computedTokenValues = await page.evaluate(
    (variables) =>
      Object.fromEntries(
        variables.map((variable) => [
          variable,
          getComputedStyle(document.documentElement).getPropertyValue(variable),
        ])
      ),
    tokenNames.map((name) => artifact.tokens?.[name]?.cssVariable ?? name)
  );
  const resolvedTokens = new Map<string, GeometryResolvedToken>();
  const violations: string[] = [];
  for (const name of tokenNames) {
    const declared = artifact.tokens?.[name];
    try {
      resolvedTokens.set(
        name,
        resolveGeometryDesignToken(
          name,
          declared,
          computedTokenValues[declared?.cssVariable ?? name]
        )
      );
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const contract of contracts) {
    const relation = contract.relation ?? { kind: 'coincident' as const };
    const token = relation.kind === 'coincident' ? undefined : resolvedTokens.get(relation.token);
    if (relation.kind !== 'coincident' && !token) continue;
    const properties = geometryContractRelationProperties(relation);
    const resolutions: GeometryContractMemberResolution[] = [];
    for (const member of contract.members) {
      const label = `${member.role}:${member.name ?? '*'}${member.all ? '[all]' : ''}`;
      const matches = await resolveGeometryContractMembers(page, member, properties);
      const playwrightNameCount =
        member.name && PLAYWRIGHT_CHECKABLE_ROLES.has(member.role)
          ? await page.getByRole(member.role as never, { name: member.name, exact: true }).count()
          : undefined;
      const samples = (member.all ? matches : matches.slice(0, 1)).map((match) => {
        const rect = contract.space === 'ink' ? match.ink : match.box;
        const hidden = rect.width <= 0 || rect.height <= 0;
        return {
          description: match.description,
          elementKey: `${match.box.x},${match.box.y},${match.box.width},${match.box.height}`,
          hidden,
          propertyValues: match.propertyValues,
          value: hidden
            ? null
            : properties
              ? match.propertyValue
              : quantizeGeometryCoordinate(
                  geometryAnchorCoordinate(rect, contract.anchor),
                  deviceScaleFactor
                ),
        };
      });
      resolutions.push({
        label,
        matchCount: matches.length,
        ...(playwrightNameCount === undefined
          ? {}
          : { playwrightNameCount, nameMatchCount: matches[0]?.nameMatchCount ?? 0 }),
        samples,
      });
    }
    violations.push(...evaluateGeometryContractResolutions(contract, resolutions, token));
  }
  return violations;
}

export async function auditChatWorkspaceSemanticAlignments(
  page: Page
): Promise<readonly BrowserSemanticAlignmentEntry[]> {
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
  const measurements = await page.evaluate(
    ({ anchors, attribute, alignmentAttributes, rules }) => {
      const root = document.querySelector(`[${attribute}="${anchors.workspaceShell}"]`);
      if (!(root instanceof HTMLElement)) throw new Error('Workspace shell is missing');
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          (rect.width > 0 || rect.height > 0) &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const describe = (element: Element) =>
        element.getAttribute(alignmentAttributes.member) ??
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
      // Capture numbers the same list in the same order, and neither pass
      // mutates the document, so this is the element identity both stages share.
      const primitiveIds = new Map(
        [document.body, ...document.body.querySelectorAll<Element>('*')].map(
          (element, index) => [element, `dom-${index + 1}`] as const
        )
      );
      const textBaseline = (element: Element) => {
        const marker = document.createElement('span');
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText =
          'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
        element.append(marker);
        const baseline = marker.getBoundingClientRect().top;
        marker.remove();
        return baseline;
      };
      const textVisualCenter = (element: Element) => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        // Same font string as capture, and for the same reason: a computed
        // `font-variant` like `tabular-nums` makes the whole string invalid,
        // and canvas then keeps the font it already had.
        const font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(
          ' '
        );
        context.font = font;
        if (!context.font.includes(style.fontSize)) {
          throw new Error(`Canvas refused the measured font: ${font}`);
        }
        // Measured from the cap-height band, not from this element's own string:
        // the ink bounds of the actual text move down whenever the label happens
        // to contain a descender, so "Document the geometry contract" and "Audit
        // row content centers" would demand different icon offsets in otherwise
        // identical rows.
        const metrics = context.measureText('H');
        const ascent = metrics.actualBoundingBoxAscent;
        const descent = metrics.actualBoundingBoxDescent;
        if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
          throw new Error(`Cannot measure visual text bounds for ${describe(element)}`);
        }
        return textBaseline(element) + (descent - ascent) / 2;
      };
      const visualCenter = (element: Element) => {
        if (element.getAttribute(alignmentAttributes.visual) === 'text') {
          return textVisualCenter(element);
        }
        if (element instanceof SVGGraphicsElement) {
          const box = element.getBBox();
          const matrix = element.getScreenCTM();
          if (matrix) {
            return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(
              matrix
            ).y;
          }
        }
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      const coordinate = (element: Element, anchor: string) => {
        const rect = element.getBoundingClientRect();
        const direction = getComputedStyle(element).direction;
        if (anchor === 'inline-start') return direction === 'rtl' ? rect.right : rect.left;
        if (anchor === 'inline-center') return rect.left + rect.width / 2;
        if (anchor === 'inline-end') return direction === 'rtl' ? rect.left : rect.right;
        if (anchor === 'block-start') return rect.top;
        if (anchor === 'block-center') return rect.top + rect.height / 2;
        if (anchor === 'block-end') return rect.bottom;
        if (anchor === 'visual-center') return visualCenter(element);
        return textBaseline(element);
      };

      return Object.values(rules).flatMap((rule) => {
        const axisAttribute = rule.axis === 'x' ? alignmentAttributes.x : alignmentAttributes.y;
        const elements = Array.from(
          root.querySelectorAll<Element>(`[${axisAttribute}="${rule.name}"]`)
        ).filter(isVisible);
        const groups = new Map<string, Element[]>();
        for (const element of elements) {
          const instance =
            rule.scope === 'instance'
              ? element
                  .closest(`[${alignmentAttributes.instance}]`)
                  ?.getAttribute(alignmentAttributes.instance)
              : null;
          const key =
            rule.scope === 'instance' ? (instance ?? '__missing-instance__') : '__global__';
          const members = groups.get(key) ?? [];
          members.push(element);
          groups.set(key, members);
        }
        return Array.from(groups.entries()).map(([instanceKey, members]) => {
          const measuredMembers = members.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: describe(element),
              text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null,
              coordinate: coordinate(element, rule.anchor),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              primitiveId: primitiveIds.get(element),
            };
          });
          const left = Math.min(...measuredMembers.map((member) => member.rect.x));
          const top = Math.min(...measuredMembers.map((member) => member.rect.y));
          const right = Math.max(
            ...measuredMembers.map((member) => member.rect.x + member.rect.width)
          );
          const bottom = Math.max(
            ...measuredMembers.map((member) => member.rect.y + member.rect.height)
          );
          return {
            rule,
            instance: rule.scope === 'instance' ? instanceKey : null,
            rect: { x: left, y: top, width: right - left, height: bottom - top },
            members: measuredMembers,
          };
        });
      });
    },
    {
      anchors: CHAT_WORKSPACE_GEOMETRY_ANCHORS,
      attribute: CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
      alignmentAttributes: CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
      rules: CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS,
    }
  );

  return measurements.map((measurement) => {
    const result = evaluateSemanticAlignmentGroup({
      ...measurement.rule,
      instance: measurement.instance,
      deviceScaleFactor,
      members: measurement.members,
    });
    return {
      groupLabel: result.instance ? `${result.name} · ${result.instance}` : result.name,
      axis: result.axis,
      anchor: result.anchor,
      policy: result.policy,
      rect: measurement.rect,
      line: result.line,
      aligned: result.aligned,
      measurable: result.measurable,
      status: result.status,
      spread: result.spread,
      members: result.members.map((member, index) => ({
        ...member,
        text: measurement.members[index]?.text ?? null,
        rect: measurement.members[index]?.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        ...(measurement.members[index]?.primitiveId
          ? { primitiveId: measurement.members[index]?.primitiveId }
          : {}),
      })),
    };
  });
}

export async function auditChatWorkspaceSemanticBaselines(
  page: Page
): Promise<readonly BrowserSemanticBaselineEntry[]> {
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
  const measurements = await page.evaluate(
    ({ anchors, attribute, baselineAttributes, alignmentAttributes }) => {
      const root = document.querySelector(`[${attribute}="${anchors.workspaceShell}"]`);
      if (!(root instanceof HTMLElement)) throw new Error('Workspace shell is missing');

      const groupSelector = `[${baselineAttributes.group}]`;
      const memberSelector = `[${baselineAttributes.member}]`;
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          (rect.width > 0 || rect.height > 0) &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const describe = (element: HTMLElement) => {
        const id = element.id ? `#${element.id}` : '';
        const classes = Array.from(element.classList)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join('');
        return `${element.tagName.toLowerCase()}${id}${classes}`;
      };
      // Capture numbers the same list in the same order, and neither pass
      // mutates the document, so this is the element identity both stages share.
      const primitiveIds = new Map(
        [document.body, ...document.body.querySelectorAll<Element>('*')].map(
          (element, index) => [element, `dom-${index + 1}`] as const
        )
      );
      const textBaseline = (element: HTMLElement) => {
        const marker = document.createElement('span');
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText =
          'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
        element.append(marker);
        const baseline = marker.getBoundingClientRect().top;
        marker.remove();
        return baseline;
      };

      return Array.from(root.querySelectorAll<HTMLElement>(groupSelector)).flatMap(
        (group, index) => {
          if (!isVisible(group)) return [];
          const mode = group.getAttribute(baselineAttributes.group);
          if (mode !== 'text') return [];
          const elements = Array.from(group.querySelectorAll<HTMLElement>(memberSelector)).filter(
            (member) => member.closest(groupSelector) === group && isVisible(member)
          );
          const rect = group.getBoundingClientRect();
          const semanticName = group.getAttribute(baselineAttributes.name);
          const instance = group
            .closest(`[${alignmentAttributes.instance}]`)
            ?.getAttribute(alignmentAttributes.instance);
          return [
            {
              name: semanticName
                ? `${semanticName}${instance ? ` · ${instance}` : ''}`
                : `${describe(group)}:${index + 1}`,
              // Narrowed by the guard above; the literal keeps that narrowing
              // across the page boundary so the caller still has the union.
              mode: 'text' as const,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              members: elements.map((element) => {
                const memberRect = element.getBoundingClientRect();
                return {
                  name: element.getAttribute(baselineAttributes.member) || describe(element),
                  text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null,
                  coordinate: textBaseline(element),
                  primitiveId: primitiveIds.get(element),
                  rect: {
                    x: memberRect.x,
                    y: memberRect.y,
                    width: memberRect.width,
                    height: memberRect.height,
                  },
                };
              }),
            },
          ];
        }
      );
    },
    {
      anchors: CHAT_WORKSPACE_GEOMETRY_ANCHORS,
      attribute: CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
      baselineAttributes: CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES,
      alignmentAttributes: CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
    }
  );

  return measurements.map((measurement) => {
    const result = evaluateSemanticBaselineGroup({
      name: measurement.name,
      mode: measurement.mode,
      deviceScaleFactor,
      members: measurement.members,
    });
    return {
      groupLabel: result.name,
      mode: result.mode,
      rect: measurement.rect,
      line: result.line,
      spread: result.spread,
      aligned: result.aligned,
      measurable: result.measurable,
      status: result.status,
      members: result.members.map((member, index) => ({
        ...member,
        text: measurement.members[index]?.text ?? null,
        rect: measurement.members[index]?.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        ...(measurement.members[index]?.primitiveId
          ? { primitiveId: measurement.members[index]?.primitiveId }
          : {}),
      })),
    };
  });
}
