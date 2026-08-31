import { expect, type Page } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
  CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES,
  CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  isSpacingRhythmMultiple,
  type ChatWorkspaceSpacingAuditProperty,
  type ChatWorkspaceGeometryAnchor,
  type ChatWorkspaceGeometrySnapshot,
  type GeometryRect,
  type GeometryViolation,
  type SemanticAlignmentAnchor,
  type SemanticAlignmentAxis,
  type SemanticAlignmentPolicy,
  type SemanticBaselineMode,
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
  members: readonly Readonly<{ name: string; coordinate: number; delta: number }>[];
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
  spread: number;
  members: readonly Readonly<{
    name: string;
    coordinate: number;
    delta: number;
    rect: GeometryRect;
  }>[];
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

export async function auditChatWorkspaceSemanticAlignments(
  page: Page
): Promise<readonly BrowserSemanticAlignmentEntry[]> {
  const measurements = await page.evaluate(
    ({ anchors, attribute, alignmentAttributes, rules }) => {
      const root = document.querySelector(`[${attribute}="${anchors.workspaceShell}"]`);
      if (!(root instanceof HTMLElement)) throw new Error('Workspace shell is missing');
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          (rect.width > 0 || rect.height > 0) &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const describe = (element: HTMLElement) =>
        element.getAttribute(alignmentAttributes.member) ??
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
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
      const coordinate = (element: HTMLElement, anchor: string) => {
        const rect = element.getBoundingClientRect();
        const direction = getComputedStyle(element).direction;
        if (anchor === 'inline-start') return direction === 'rtl' ? rect.right : rect.left;
        if (anchor === 'inline-center') return rect.left + rect.width / 2;
        if (anchor === 'inline-end') return direction === 'rtl' ? rect.left : rect.right;
        if (anchor === 'block-start') return rect.top;
        if (anchor === 'block-center') return rect.top + rect.height / 2;
        if (anchor === 'block-end') return rect.bottom;
        return textBaseline(element);
      };

      return Object.values(rules).flatMap((rule) => {
        const axisAttribute = rule.axis === 'x' ? alignmentAttributes.x : alignmentAttributes.y;
        const elements = Array.from(
          root.querySelectorAll<HTMLElement>(`[${axisAttribute}="${rule.name}"]`)
        ).filter(isVisible);
        const groups = new Map<string, HTMLElement[]>();
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
      spread: result.spread,
      members: result.members.map((member, index) => ({
        ...member,
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
          if (elements.length < 2) return [];
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
                return {
                  name: element.getAttribute(baselineAttributes.member) || describe(element),
                  coordinate: textBaseline(element),
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
      members: result.members,
    };
  });
}
