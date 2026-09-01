import { Mesurer } from 'mesurer';
import { useEffect, useLayoutEffect, useState } from 'react';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
  CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES,
  CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  isSpacingRhythmMultiple,
  type CalculatedMainPaneGrid,
  type CalculatedSidebarGrid,
  type ChatWorkspaceSpacingAuditProperty,
  type GeometryRect,
  type SemanticAlignmentAnchor,
  type SemanticAlignmentAxis,
  type SemanticAlignmentPolicy,
  type SemanticBaselineMode,
  type SemanticGeometryStatus,
} from '@/lib/chat-workspace-geometry';

const ENABLE_QUERY_PARAMETER = 'geometry';
const ENABLE_STORAGE_KEY = 'lody:chat-workspace-geometry-devtools';

type GridOverlayMeasurement = Readonly<{
  scope: 'main' | 'sidebar';
  pane: GeometryRect;
  grid: CalculatedMainPaneGrid | CalculatedSidebarGrid;
}>;

type SpacingAuditEntry = Readonly<{
  elementLabel: string;
  scopeAnchor: string | null;
  rect: GeometryRect;
  violations: readonly Readonly<{
    property: ChatWorkspaceSpacingAuditProperty;
    value: number;
  }>[];
}>;

type SemanticBaselineEntry = Readonly<{
  groupLabel: string;
  mode: SemanticBaselineMode;
  rect: GeometryRect;
  line: number;
  spread: number;
  aligned: boolean;
  measurable: boolean;
  status: SemanticGeometryStatus;
  members: readonly Readonly<{ name: string; coordinate: number; delta: number }>[];
}>;

type SemanticAlignmentEntry = Readonly<{
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
    coordinate: number;
    delta: number;
    rect: GeometryRect;
  }>[];
}>;

function semanticStatusColor(status: SemanticGeometryStatus): string {
  if (status === 'aligned') return 'rgb(16 185 129 / 0.72)';
  if (status === 'sub-pixel-jitter') return 'rgb(217 119 6 / 0.72)';
  if (status === 'insufficient-evidence') return 'rgb(100 116 139 / 0.62)';
  return 'rgb(244 63 94 / 0.82)';
}

export function resolveWorkspaceGeometryDevtoolsEnabled(
  search: string,
  storedValue: string | null
): boolean {
  const parameter = new URLSearchParams(search).get(ENABLE_QUERY_PARAMETER);
  if (parameter != null) return parameter === '1' || parameter === 'true' || parameter === 'on';
  return storedValue === '1';
}

function readEnabledState(): boolean {
  let storedValue: string | null = null;
  try {
    storedValue = window.localStorage.getItem(ENABLE_STORAGE_KEY);
  } catch {
    // A query parameter remains usable when storage is unavailable.
  }
  return resolveWorkspaceGeometryDevtoolsEnabled(window.location.search, storedValue);
}

function useEnabledState(): boolean {
  const [enabled, setEnabled] = useState(readEnabledState);

  useEffect(() => {
    const refresh = () => setEnabled(readEnabledState());
    window.addEventListener('popstate', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('popstate', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return enabled;
}

function readRect(element: Element): GeometryRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function readGridMeasurements(): readonly GridOverlayMeasurement[] {
  const selectors = [
    {
      scope: 'sidebar' as const,
      anchor: CHAT_WORKSPACE_GEOMETRY_ANCHORS.sidebarCard,
      calculate: calculateSidebarGrid,
    },
    {
      scope: 'main' as const,
      anchor: CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane,
      calculate: calculateMainPaneGrid,
    },
  ];
  return selectors.flatMap(({ scope, anchor, calculate }) => {
    const element = document.querySelector(`[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${anchor}"]`);
    if (!(element instanceof HTMLElement)) return [];
    const pane = readRect(element);
    try {
      return [{ scope, pane, grid: calculate(pane) }];
    } catch {
      return [];
    }
  });
}

function ReferenceGridOverlay() {
  const [measurements, setMeasurements] = useState<readonly GridOverlayMeasurement[]>([]);

  useLayoutEffect(() => {
    const elements = [
      CHAT_WORKSPACE_GEOMETRY_ANCHORS.sidebarCard,
      CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane,
    ].flatMap((anchor) => {
      const element = document.querySelector(`[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${anchor}"]`);
      return element instanceof HTMLElement ? [element] : [];
    });
    if (elements.length === 0) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMeasurements(readGridMeasurements()));
    };
    const observer = new ResizeObserver(measure);
    elements.forEach((element) => observer.observe(element));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, []);

  if (measurements.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      data-geometry-devtool="reference-grid"
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2_147_483_000 }}
    >
      {measurements.map((measurement) => (
        <div
          key={measurement.scope}
          data-geometry-grid-scope={measurement.scope}
          style={{
            position: 'absolute',
            overflow: 'hidden',
            left: measurement.pane.x,
            top: measurement.pane.y,
            width: measurement.pane.width,
            height: measurement.pane.height,
          }}
        >
          <div
            style={{
              position: 'absolute',
              insetBlock: 0,
              left: measurement.grid.content.x - measurement.pane.x,
              width: measurement.grid.content.width,
              borderInline: `1px solid ${
                measurement.scope === 'sidebar'
                  ? 'rgb(99 102 241 / 0.24)'
                  : 'rgb(14 165 233 / 0.24)'
              }`,
            }}
          />
          {measurement.grid.columns.map((column) => (
            <div
              key={`column-${column.index}`}
              style={{
                position: 'absolute',
                insetBlock: 0,
                left: column.rect.x - measurement.pane.x,
                width: column.rect.width,
                background:
                  measurement.scope === 'sidebar'
                    ? 'rgb(99 102 241 / 0.03)'
                    : 'rgb(14 165 233 / 0.03)',
                borderInline: `1px solid ${
                  measurement.scope === 'sidebar'
                    ? 'rgb(99 102 241 / 0.15)'
                    : 'rgb(14 165 233 / 0.15)'
                }`,
              }}
            />
          ))}
          {measurement.grid.gutters.map((gutter, index) => (
            <div
              key={`gutter-${index + 1}`}
              style={{
                position: 'absolute',
                insetBlock: 0,
                left: gutter.x - measurement.pane.x,
                width: gutter.width,
                background: 'rgb(244 63 94 / 0.012)',
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function elementUsesLineHeight(element: HTMLElement): boolean {
  if (element.matches('button, input, select, textarea')) return true;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
  );
}

function describeElement(element: Element): string {
  const anchor = element.getAttribute(CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE);
  if (anchor) return `[${anchor}]`;
  if (element.id) return `${element.tagName.toLowerCase()}#${element.id}`;

  const classNames = Array.from(element.classList).slice(0, 2);
  return `${element.tagName.toLowerCase()}${classNames.map((name) => `.${name}`).join('')}`;
}

function toCssPropertyName(property: ChatWorkspaceSpacingAuditProperty): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function readSpacingAudit(): readonly SpacingAuditEntry[] {
  const root = document.querySelector(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  if (!(root instanceof HTMLElement)) return [];

  const entries: SpacingAuditEntry[] = [];
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const element of elements) {
    if (element.closest('[data-geometry-spacing-ignore]')) continue;

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
    const violations: Array<{
      property: ChatWorkspaceSpacingAuditProperty;
      value: number;
    }> = [];

    for (const property of CHAT_WORKSPACE_SPACING_AUDIT_PROPERTIES) {
      if (property === 'lineHeight' && !elementUsesLineHeight(element)) continue;
      const typedValue = typedStyle?.get(toCssPropertyName(property))?.toString();
      if (typedValue === 'auto' || typedValue === 'normal') continue;
      const value = Number.parseFloat(style[property]);
      if (!Number.isFinite(value) || value === 0) continue;
      if (
        isSpacingRhythmMultiple(
          Math.abs(value),
          CHAT_WORKSPACE_GEOMETRY_SPEC.spacingStep,
          CHAT_WORKSPACE_GEOMETRY_SPEC.defaultTolerance
        )
      ) {
        continue;
      }
      violations.push({ property, value });
    }

    if (violations.length === 0) continue;
    entries.push({
      elementLabel: describeElement(element),
      scopeAnchor:
        element
          .closest(`[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}]`)
          ?.getAttribute(CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE) ?? null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      violations,
    });
  }

  return entries;
}

function SpacingAuditOverlay() {
  const [entries, setEntries] = useState<readonly SpacingAuditEntry[]>([]);

  useLayoutEffect(() => {
    const root = document.querySelector(
      `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
    );
    if (!(root instanceof HTMLElement)) return;

    let frame = 0;
    const audit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setEntries(readSpacingAudit()));
    };
    const resizeObserver = new ResizeObserver(audit);
    const mutationObserver = new MutationObserver(audit);
    resizeObserver.observe(root);
    mutationObserver.observe(root, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', audit);
    window.addEventListener('scroll', audit, true);
    audit();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', audit);
      window.removeEventListener('scroll', audit, true);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-geometry-devtool="spacing-audit"
      data-geometry-spacing-violation-count={entries.length}
      style={{ position: 'fixed', inset: 0, zIndex: 2_147_483_001, pointerEvents: 'none' }}
    >
      {entries.map((entry, index) => (
        <div
          key={`${entry.elementLabel}-${entry.rect.x}-${entry.rect.y}-${index}`}
          data-geometry-spacing-scope={entry.scopeAnchor ?? undefined}
          data-geometry-spacing-values={entry.violations
            .map(({ property, value }) => `${property}=${Number(value.toFixed(2))}`)
            .join(' ')}
          style={{
            position: 'absolute',
            left: entry.rect.x,
            top: entry.rect.y,
            width: entry.rect.width,
            height: entry.rect.height,
            border: '1px solid rgb(245 158 11 / 0.14)',
            background: 'rgb(245 158 11 / 0.006)',
          }}
        />
      ))}
    </div>
  );
}

function isVisibleForGeometry(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    (rect.width > 0 || rect.height > 0) && style.display !== 'none' && style.visibility !== 'hidden'
  );
}

function measureTextBaseline(element: Element): number {
  const marker = document.createElement('span');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText =
    'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
  element.append(marker);
  const baseline = marker.getBoundingClientRect().top;
  marker.remove();
  return baseline;
}

function measureTextVisualCenter(element: Element): number {
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
  return (
    measureTextBaseline(element) +
    (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
  );
}

function measureVisualCenter(element: Element): number {
  if (element.getAttribute(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.visual) === 'text') {
    return measureTextVisualCenter(element);
  }
  if (element instanceof SVGGraphicsElement) {
    const box = element.getBBox();
    const matrix = element.getScreenCTM();
    if (matrix) {
      return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(matrix).y;
    }
  }
  const rect = element.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

function measureSemanticAlignmentCoordinate(
  element: Element,
  anchor: SemanticAlignmentAnchor
): number {
  const rect = element.getBoundingClientRect();
  const direction = getComputedStyle(element).direction;
  switch (anchor) {
    case 'inline-start':
      return direction === 'rtl' ? rect.right : rect.left;
    case 'inline-center':
      return rect.left + rect.width / 2;
    case 'inline-end':
      return direction === 'rtl' ? rect.left : rect.right;
    case 'block-start':
      return rect.top;
    case 'block-center':
      return rect.top + rect.height / 2;
    case 'block-end':
      return rect.bottom;
    case 'text-baseline':
      return measureTextBaseline(element);
    case 'visual-center':
      return measureVisualCenter(element);
  }
}

function unionRects(rects: readonly GeometryRect[]): GeometryRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function readSemanticAlignments(): readonly SemanticAlignmentEntry[] {
  const root = document.querySelector(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  if (!(root instanceof HTMLElement)) return [];

  return Object.values(CHAT_WORKSPACE_SEMANTIC_ALIGNMENTS).flatMap((rule) => {
    const attribute =
      rule.axis === 'x'
        ? CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.x
        : CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.y;
    const elements = Array.from(
      root.querySelectorAll<Element>(`[${attribute}="${rule.name}"]`)
    ).filter(isVisibleForGeometry);
    const groups = new Map<string, Element[]>();
    for (const element of elements) {
      const instance =
        rule.scope === 'instance'
          ? element
              .closest(`[${CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.instance}]`)
              ?.getAttribute(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.instance)
          : null;
      const key = rule.scope === 'instance' ? (instance ?? '__missing-instance__') : '__global__';
      const members = groups.get(key) ?? [];
      members.push(element);
      groups.set(key, members);
    }

    return Array.from(groups.entries()).map(([instanceKey, members]) => {
      const measuredMembers = members.map((element) => ({
        name:
          element.getAttribute(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.member) ??
          describeElement(element),
        coordinate: measureSemanticAlignmentCoordinate(element, rule.anchor),
        rect: readRect(element),
      }));
      const result = evaluateSemanticAlignmentGroup({
        ...rule,
        instance: rule.scope === 'instance' ? instanceKey : null,
        members: measuredMembers,
      });
      return {
        groupLabel: result.instance ? `${result.name} · ${result.instance}` : result.name,
        axis: result.axis,
        anchor: result.anchor,
        policy: result.policy,
        rect: unionRects(measuredMembers.map((member) => member.rect)),
        line: result.line,
        aligned: result.aligned,
        measurable: result.measurable,
        status: result.status,
        spread: result.spread,
        members: result.members.map((member, index) => ({
          ...member,
          rect: measuredMembers[index]?.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        })),
      };
    });
  });
}

function SemanticAlignmentOverlay() {
  const [entries, setEntries] = useState<readonly SemanticAlignmentEntry[]>([]);

  useLayoutEffect(() => {
    const root = document.querySelector(
      `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
    );
    if (!(root instanceof HTMLElement)) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setEntries(readSemanticAlignments()));
    };
    const resizeObserver = new ResizeObserver(measure);
    const mutationObserver = new MutationObserver(measure);
    resizeObserver.observe(root);
    mutationObserver.observe(root, { attributes: true, childList: true, subtree: true });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, []);

  const violations = entries.filter((entry) => entry.status === 'violation');
  return (
    <div
      aria-hidden="true"
      data-geometry-devtool="semantic-alignments"
      data-geometry-alignment-group-count={entries.length}
      data-geometry-alignment-violation-count={violations.length}
      style={{ position: 'fixed', inset: 0, zIndex: 2_147_483_003, pointerEvents: 'none' }}
    >
      {entries.map((entry, index) => {
        const color = semanticStatusColor(entry.status);
        return (
          <div
            key={`${entry.groupLabel}-${index}`}
            data-geometry-alignment-name={entry.groupLabel}
            data-geometry-alignment-axis={entry.axis}
            data-geometry-alignment-anchor={entry.anchor}
            data-geometry-alignment-aligned={entry.aligned ? 'true' : 'false'}
            data-geometry-alignment-status={entry.status}
            data-geometry-alignment-spread={Number(entry.spread.toFixed(2))}
            style={{
              position: 'absolute',
              left: entry.rect.x,
              top: entry.rect.y,
              width: entry.rect.width,
              height: entry.rect.height,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: entry.axis === 'x' ? entry.line - entry.rect.x : 0,
                right: entry.axis === 'y' ? 0 : undefined,
                top: entry.axis === 'y' ? entry.line - entry.rect.y : 0,
                bottom: entry.axis === 'x' ? 0 : undefined,
                width: entry.axis === 'x' ? 1 : undefined,
                height: entry.axis === 'y' ? 1 : undefined,
                background: color,
                boxShadow: `0 0 0 0.5px ${color}`,
              }}
            />
            {entry.status === 'violation' || entry.status === 'sub-pixel-jitter'
              ? entry.members.map((member, memberIndex) => (
                  <span
                    key={`${member.name}-${memberIndex}`}
                    style={{
                      position: 'absolute',
                      left:
                        entry.axis === 'x'
                          ? member.coordinate - entry.rect.x
                          : member.rect.x - entry.rect.x,
                      top:
                        entry.axis === 'y'
                          ? member.coordinate - entry.rect.y
                          : member.rect.y - entry.rect.y,
                      width: entry.axis === 'x' ? 1 : member.rect.width,
                      height: entry.axis === 'y' ? 1 : member.rect.height,
                      background:
                        entry.status === 'violation'
                          ? 'rgb(244 63 94 / 0.24)'
                          : 'rgb(217 119 6 / 0.18)',
                    }}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

function readSemanticBaselines(): readonly SemanticBaselineEntry[] {
  const root = document.querySelector(
    `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
  );
  if (!(root instanceof HTMLElement)) return [];

  const groupSelector = `[${CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES.group}]`;
  const memberSelector = `[${CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES.member}]`;
  return Array.from(root.querySelectorAll<HTMLElement>(groupSelector)).flatMap((group, index) => {
    if (!isVisibleForGeometry(group)) return [];
    const mode = group.getAttribute(
      CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES.group
    ) as SemanticBaselineMode | null;
    if (mode !== 'text') return [];

    const elements = Array.from(group.querySelectorAll<HTMLElement>(memberSelector)).filter(
      (member) => member.closest(groupSelector) === group && isVisibleForGeometry(member)
    );
    const result = evaluateSemanticBaselineGroup({
      name: (() => {
        const semanticName = group.getAttribute(CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES.name);
        const instance = group
          .closest(`[${CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.instance}]`)
          ?.getAttribute(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES.instance);
        return semanticName
          ? `${semanticName}${instance ? ` · ${instance}` : ''}`
          : `${describeElement(group)}:${index + 1}`;
      })(),
      mode,
      members: elements.map((element) => {
        return {
          name:
            element.getAttribute(CHAT_WORKSPACE_SEMANTIC_BASELINE_ATTRIBUTES.member) ||
            describeElement(element),
          coordinate: measureTextBaseline(element),
        };
      }),
    });
    return [
      {
        groupLabel: result.name,
        mode,
        rect: readRect(group),
        line: result.line,
        spread: result.spread,
        aligned: result.aligned,
        measurable: result.measurable,
        status: result.status,
        members: result.members,
      },
    ];
  });
}

function SemanticBaselineOverlay() {
  const [entries, setEntries] = useState<readonly SemanticBaselineEntry[]>([]);

  useLayoutEffect(() => {
    const root = document.querySelector(
      `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
    );
    if (!(root instanceof HTMLElement)) return;

    let frame = 0;
    const mutationObserver = new MutationObserver(schedule);
    const observeMutations = () =>
      mutationObserver.observe(root, { attributes: true, childList: true, subtree: true });
    const measure = () => {
      mutationObserver.disconnect();
      setEntries(readSemanticBaselines());
      mutationObserver.takeRecords();
      observeMutations();
    };
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    observeMutations();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, []);

  const violationCount = entries.filter((entry) => entry.status === 'violation').length;
  return (
    <div
      aria-hidden="true"
      data-geometry-devtool="semantic-baselines"
      data-geometry-baseline-group-count={entries.length}
      data-geometry-baseline-violation-count={violationCount}
      style={{ position: 'fixed', inset: 0, zIndex: 2_147_483_002, pointerEvents: 'none' }}
    >
      {entries.map((entry, index) => {
        const color = semanticStatusColor(entry.status);
        return (
          <div
            key={`${entry.groupLabel}-${index}`}
            data-geometry-baseline-name={entry.groupLabel}
            data-geometry-baseline-aligned={entry.aligned ? 'true' : 'false'}
            data-geometry-baseline-status={entry.status}
            data-geometry-baseline-mode={entry.mode}
            data-geometry-baseline-spread={Number(entry.spread.toFixed(2))}
            style={{
              position: 'absolute',
              left: entry.rect.x,
              top: entry.rect.y,
              width: entry.rect.width,
              height: entry.rect.height,
              border: 0,
              background: entry.status === 'violation' ? 'rgb(244 63 94 / 0.008)' : 'transparent',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: entry.line - entry.rect.y,
                height: 1,
                background: color,
                boxShadow: `0 0 0 0.5px ${color}`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function WorkspaceGeometryDevtools({
  forceEnabled = false,
}: {
  forceEnabled?: boolean;
}) {
  const enabled = useEnabledState();
  const active = enabled || forceEnabled;

  useEffect(() => {
    if (!active) return;
    const root = document.querySelector(
      `[${CHAT_WORKSPACE_GEOMETRY_ATTRIBUTE}="${CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell}"]`
    );
    if (!(root instanceof HTMLElement)) return;
    root.setAttribute('data-geometry-actions-visible', 'true');
    return () => root.removeAttribute('data-geometry-actions-visible');
  }, [active]);

  if (!active) return null;

  return (
    <>
      <style>{`
        [data-geometry-actions-visible="true"] [data-geometry-hover-action] {
          opacity: 1 !important;
          pointer-events: none !important;
        }
        [data-geometry-actions-visible="true"] [data-geometry-hover-rest] {
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `}</style>
      <ReferenceGridOverlay />
      <SpacingAuditOverlay />
      <SemanticAlignmentOverlay />
      <SemanticBaselineOverlay />
      <Mesurer
        guideColor="oklch(0.63 0.26 29.23)"
        highlightColor="oklch(0.62 0.18 255)"
        hoverHighlightEnabled={false}
        multiMeasureEnabled
        persistKey="lody-chat-workspace-geometry"
        persistOnReload
      />
    </>
  );
}
