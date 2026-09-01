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
  discoverAlignmentRails,
  discoverRepeatedLayoutScopes,
  groupAlignmentRailFamilies,
  isSpacingRhythmMultiple,
  selectCanonicalAlignmentRails,
  type ChatWorkspaceSpacingAuditProperty,
  type ChatWorkspaceGeometryAnchor,
  type ChatWorkspaceGeometrySnapshot,
  type GeometryRect,
  type GeometryViolation,
  type AlignmentRailCandidate,
  type AlignmentRailFamily,
  type DiscoveredAlignmentRail,
  type LayoutTopologyNode,
  type SemanticAlignmentAnchor,
  type SemanticAlignmentAxis,
  type SemanticAlignmentPolicy,
  type SemanticBaselineMode,
  type SemanticGeometryStatus,
  type SpacingMeasurement,
} from '../../../src/lib/chat-workspace-geometry';

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
  }>[];
}>;

export type BrowserAlignmentRailDiscoveryScope = Readonly<{
  scope: string;
  source: 'hint' | 'auto';
  rect: GeometryRect;
  candidateCount: number;
  rails: readonly DiscoveredAlignmentRail[];
  railFamilies: readonly AlignmentRailFamily[];
  topology?: Readonly<{
    signature: string;
    instanceCount: number;
    confidence: number;
  }>;
}>;

const anchorValues = Object.values(CHAT_WORKSPACE_GEOMETRY_ANCHORS);
const STABILITY_TOLERANCE = 0.01;
const MAX_SETTLING_FRAMES = 8;

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
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 30_000,
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

export async function discoverChatWorkspaceAlignmentRails(
  page: Page,
  options: Readonly<{ aggregateScopes?: readonly string[] }> = {}
): Promise<readonly BrowserAlignmentRailDiscoveryScope[]> {
  const snapshot = await page.evaluate(
    ({ discoveryAttribute, aggregateScopes }) => {
      const isRendered = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
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
        label: string;
        kind: string;
        space: 'ink' | 'layout-box';
        rect: Readonly<{ x: number; y: number; width: number; height: number }>;
      }>;
      const plainRect = (rect: DOMRectReadOnly) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      const unionRects = (rects: readonly DOMRectReadOnly[]) => {
        if (rects.length === 0) return null;
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        return { x: left, y: top, width: right - left, height: bottom - top };
      };
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
      const measureDirectText = (element: Element) => {
        const rects = Array.from(element.childNodes).flatMap((node) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
          const range = document.createRange();
          range.selectNodeContents(node);
          return Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0
          );
        });
        return unionRects(rects);
      };
      const measureSvgInk = (element: Element) => {
        if (!(element instanceof SVGGraphicsElement)) {
          return plainRect(element.getBoundingClientRect());
        }
        try {
          const box = element.getBBox();
          const matrix = element.getScreenCTM();
          if (!matrix || box.width <= 0 || box.height <= 0) {
            return plainRect(element.getBoundingClientRect());
          }
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
          return { x: left, y: top, width: right - left, height: bottom - top };
        } catch {
          return plainRect(element.getBoundingClientRect());
        }
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
      const directVisualPrimitive = (
        element: Element,
        boundary: Element
      ): VisualPrimitive | null => {
        const text = directText(element);
        if (text) {
          const rect = measureDirectText(element);
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            label: text.slice(0, 48),
            kind: /^[+\-\u2212\d\s]+$/.test(text) ? 'numeric-text' : 'text',
            space: 'ink',
            rect,
          };
        }
        if (element.matches('svg')) {
          const rect = measureSvgInk(element);
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
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
            label: primitiveLabel(element, boundary),
            kind: 'image',
            space: 'ink',
            rect,
          };
        }
        if (element.matches('input, select, textarea')) {
          const rect = plainRect(element.getBoundingClientRect());
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            element,
            label: primitiveLabel(element, boundary),
            kind: 'field',
            space: 'layout-box',
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
          const slots = Array.from(element.children).filter((child) => {
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

        const candidates = rows.flatMap((row, rowIndex) => {
          const rowCenter = row.rect.top + row.rect.height / 2;
          return row.slots.flatMap((slot, slotIndex) => {
            return visualPrimitivesWithin(slot).flatMap((primitive, primitiveIndex) => {
              const { rect } = primitive;
              const elementId = `${rowIndex + 1}.${slotIndex + 1}.${primitiveIndex + 1}:${
                primitive.label
              }`;
              const common = {
                elementId,
                rowId: `visual-row:${Number(rowCenter.toFixed(1))}:${Number(row.rect.x.toFixed(1))}`,
                kind: primitive.kind,
                space: primitive.space,
                yStart: rect.y,
                yEnd: rect.y + rect.height,
              };
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
            const common = {
              elementId: `${index + 1}:${primitive.label}`,
              rowId: `visual-row:${Number((rect.y + rect.height / 2).toFixed(1))}:${Number(
                rect.x.toFixed(1)
              )}`,
              kind: primitive.kind,
              space: primitive.space,
              yStart: rect.y,
              yEnd: rect.y + rect.height,
            };
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
          rect: {
            x: scopeRect.x,
            y: scopeRect.y,
            width: scopeRect.width,
            height: scopeRect.height,
          },
          rowCount: rows.length,
          candidates,
        };
      };

      const manualScopes = Array.from(
        document.querySelectorAll<Element>(`[${discoveryAttribute}]`)
      ).map((scopeElement) => {
        const scope = scopeElement.getAttribute(discoveryAttribute) ?? 'unnamed';
        return scopeSnapshot(scopeElement, scope, aggregateScopes.includes(scope), true);
      });

      const regionScopes = Array.from(
        document.body.querySelectorAll<Element>('aside, main, nav, section, div, ul, ol')
      )
        .filter((element) => {
          if (element.closest('[data-geometry-devtool]') || !isRendered(element)) return false;
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
        (element) => !element.closest('[data-geometry-devtool]') && isRendered(element)
      );
      const idByElement = new Map(
        topologyElements.map((element, index) => [element, `dom-${index + 1}`] as const)
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
          elementId: primitive ? `${index + 1}:${primitive.label}` : null,
          primitive: primitive
            ? {
                kind: primitive.kind,
                space: primitive.space,
                rect: primitive.rect,
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
    }
  );

  const discoverScopeRails = (
    candidates: readonly AlignmentRailCandidate[],
    rect: GeometryRect
  ) => {
    const heights = candidates
      .map((candidate) => candidate.yEnd - candidate.yStart)
      .filter((height) => Number.isFinite(height) && height > 0)
      .sort((left, right) => left - right);
    const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 16;
    const mergeTolerance = Math.max(4, Math.min(12, typicalHeight / 2));
    const rawRails = discoverAlignmentRails(candidates, {
      mergeTolerance,
      minSupport: 2,
      scopeHeight: rect.height,
    });
    return {
      rails: selectCanonicalAlignmentRails(rawRails, rect),
      railFamilies: groupAlignmentRailFamilies(rawRails),
    };
  };

  const manualScopes: BrowserAlignmentRailDiscoveryScope[] = snapshot.manualScopes.map(
    ({ scope, rect, candidates }) => ({
      scope,
      source: 'hint',
      rect,
      candidateCount: candidates.length,
      ...discoverScopeRails(candidates as readonly AlignmentRailCandidate[], rect),
    })
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
  const regionScopes: BrowserAlignmentRailDiscoveryScope[] = snapshot.regionScopes
    .filter(
      ({ rect }) => !manualScopes.some((manualScope) => overlapShare(rect, manualScope.rect) >= 0.8)
    )
    .map(({ scope, rect, rowCount, candidates }) => ({
      scope,
      source: 'auto',
      rect,
      candidateCount: candidates.length,
      ...discoverScopeRails(candidates as readonly AlignmentRailCandidate[], rect),
      topology: {
        signature: 'geometry-region',
        instanceCount: rowCount,
        confidence: Math.min(1, rowCount / 6),
      },
    }));

  type BrowserTopologyNode = LayoutTopologyNode &
    Readonly<{
      elementId: string | null;
      primitive: Readonly<{
        kind: string;
        space: 'ink' | 'layout-box';
        rect: GeometryRect;
      }> | null;
    }>;
  const topologyNodes = snapshot.topologyNodes as readonly BrowserTopologyNode[];
  const topologyById = new Map(topologyNodes.map((node) => [node.id, node]));
  const autoScopes = discoverRepeatedLayoutScopes(topologyNodes).map(
    (autoScope): BrowserAlignmentRailDiscoveryScope => {
      const instanceIds = new Set(autoScope.instanceIds);
      const candidates = topologyNodes.flatMap((node): readonly AlignmentRailCandidate[] => {
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
        const yStart = rect.y;
        const yEnd = rect.y + rect.height;
        return [
          {
            elementId: node.elementId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            kind: node.primitive.kind,
            space: node.primitive.space,
            anchor: 'inline-start',
            coordinate: rect.x,
            yStart,
            yEnd,
          },
          {
            elementId: node.elementId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            kind: node.primitive.kind,
            space: node.primitive.space,
            anchor: 'inline-center',
            coordinate: rect.x + rect.width / 2,
            yStart,
            yEnd,
          },
          {
            elementId: node.elementId,
            rowId: `${autoScope.id}:${ancestor.id}`,
            kind: node.primitive.kind,
            space: node.primitive.space,
            anchor: 'inline-end',
            coordinate: rect.x + rect.width,
            yStart,
            yEnd,
          },
        ];
      });
      const discovered = discoverScopeRails(candidates, autoScope.rect);
      return {
        scope: autoScope.id,
        source: 'auto',
        rect: autoScope.rect,
        candidateCount: candidates.length,
        ...discovered,
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

export async function auditChatWorkspaceSemanticAlignments(
  page: Page
): Promise<readonly BrowserSemanticAlignmentEntry[]> {
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
        context.font = [
          style.fontStyle,
          style.fontVariant,
          style.fontWeight,
          style.fontSize,
          style.fontFamily,
        ].join(' ');
        const metrics = context.measureText(element.textContent ?? '');
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
      })),
    };
  });
}

export async function auditChatWorkspaceSemanticBaselines(
  page: Page
): Promise<readonly BrowserSemanticBaselineEntry[]> {
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
              mode,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              members: elements.map((element) => {
                const memberRect = element.getBoundingClientRect();
                return {
                  name: element.getAttribute(baselineAttributes.member) || describe(element),
                  text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) || null,
                  coordinate: textBaseline(element),
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
      })),
    };
  });
}
