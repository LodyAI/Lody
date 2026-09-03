import { describe, expect, it } from 'vitest';

import {
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  calculateSpacingRhythmCoordinates,
  calculateGridPlacementRect,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  discoverAlignmentRails,
  discoverBlockAlignmentRails,
  discoverRepeatedLayoutScopes,
  inferAlignmentRailContractProposals,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  isGeometryPaintedShape,
  isSpacingRhythmMultiple,
  resolveConversationHorizontalInset,
  resolveMainPaneGridRange,
  selectCanonicalAlignmentRails,
  selectVisualRowSlots,
  validateChatWorkspaceGeometry,
  type AlignmentRailCandidate,
  type BlockRailCandidate,
  type ChatWorkspaceGeometrySnapshot,
  type LayoutTopologyNode,
} from '../src/lib/chat-workspace-geometry';
import { geometryCanvasFontString } from '../src/lib/geometry-text-cap-band';

const anchors = CHAT_WORKSPACE_GEOMETRY_ANCHORS;

function expandedWorkspaceSnapshot(): ChatWorkspaceGeometrySnapshot {
  return {
    [anchors.workspaceShell]: { x: 0, y: 0, width: 1440, height: 900 },
    [anchors.sidebarSlot]: { x: 0, y: 0, width: 292, height: 900 },
    [anchors.sidebarCard]: { x: 8, y: 8, width: 280, height: 884 },
    [anchors.mainPane]: { x: 292, y: 0, width: 1148, height: 900 },
    [anchors.chatLanding]: { x: 292, y: 0, width: 1148, height: 900 },
    [anchors.greetingRegion]: { x: 292, y: 0, width: 1148, height: 668 },
    [anchors.composerBand]: { x: 292, y: 668, width: 1148, height: 232 },
    [anchors.conversationColumn]: { x: 498, y: 668, width: 736, height: 224 },
  };
}

describe('main-pane design grid', () => {
  it('selects ranges from main-pane width instead of viewport width', () => {
    expect(resolveMainPaneGridRange(639).name).toBe('compact');
    expect(resolveMainPaneGridRange(640).name).toBe('medium');
    expect(resolveMainPaneGridRange(1023).name).toBe('medium');
    expect(resolveMainPaneGridRange(1024).name).toBe('wide');
  });

  it('calculates columns, gutters, and configured margins in document coordinates', () => {
    const grid = calculateMainPaneGrid({ x: 292, y: 0, width: 1148, height: 900 });

    expect(grid.range).toMatchObject({ name: 'wide', columns: 12, margin: 32, gutter: 24 });
    expect(grid.content).toEqual({ x: 324, y: 0, width: 1084, height: 900 });
    expect(grid.columns).toHaveLength(12);
    expect(grid.gutters).toHaveLength(11);
    expect(grid.columnWidth).toBeCloseTo(68.333333, 5);
    expect(grid.columns[0]?.rect.x).toBe(324);
    expect(grid.columns[11]?.rect.x).toBeCloseTo(1339.666667, 5);
    expect(grid.columnGuides).toHaveLength(24);
  });

  it('centres the capped content frame and grows only its visible margins', () => {
    const grid = calculateMainPaneGrid({ x: 100, y: 20, width: 1800, height: 700 });

    expect(grid.content).toEqual({ x: 280, y: 20, width: 1440, height: 700 });
    expect(grid.visibleMargin).toBe(180);
  });

  it('derives a multi-column placement including its internal gutters', () => {
    const grid = calculateMainPaneGrid({ x: 0, y: 0, width: 800, height: 600 });
    const placement = calculateGridPlacementRect(grid, 2, 3);

    expect(grid.range.name).toBe('medium');
    expect(placement.x).toBeCloseTo(120.5);
    expect(placement.width).toBeCloseTo(269.5);
    expect(() => calculateGridPlacementRect(grid, 7, 3)).toThrow(/exceeds 8 columns/);
  });

  it('pins verification cases that exercise every range, the content cap, and collapse', () => {
    const cases = CHAT_WORKSPACE_GEOMETRY_SPEC.verificationCases;
    expect(cases.map((testCase) => testCase.name)).toEqual([
      'narrow-expanded',
      'standard-expanded',
      'wide-expanded',
      'content-cap-expanded',
      'boundary-collapsed',
    ]);

    const sidebarSlotExtra =
      CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.left +
      CHAT_WORKSPACE_GEOMETRY_SPEC.sidebar.cardInset.right;
    for (const testCase of cases) {
      const paneWidth =
        testCase.sidebar === 'expanded'
          ? testCase.viewport.width - (testCase.sidebarWidth + sidebarSlotExtra)
          : testCase.viewport.width;
      expect(resolveMainPaneGridRange(paneWidth).name).toBe(testCase.expectedGridRange);
    }
  });

  it('rejects panes that cannot contain the fixed margins and gutters', () => {
    expect(() => calculateMainPaneGrid({ x: 0, y: 0, width: 60, height: 400 })).toThrow(
      /too narrow for the compact grid/
    );
  });

  it('calculates a four-column local grid inside the Sidebar card', () => {
    const grid = calculateSidebarGrid({ x: 8, y: 8, width: 280, height: 884 });

    expect(grid.range).toEqual({ name: 'sidebar', columns: 4, margin: 12, gutter: 8 });
    expect(grid.content).toEqual({ x: 20, y: 8, width: 256, height: 884 });
    expect(grid.columnWidth).toBe(58);
    expect(grid.columns).toHaveLength(4);
    expect(grid.gutters).toHaveLength(3);
  });
});

describe('conversation, spacing, and semantic baselines', () => {
  it('uses the conversation inset breakpoint relative to the main pane', () => {
    expect(resolveConversationHorizontalInset(639)).toBe(12);
    expect(resolveConversationHorizontalInset(640)).toBe(16);
  });

  it('checks measured distances without constraining absolute page coordinates', () => {
    expect(isSpacingRhythmMultiple(20.4)).toBe(true);
    expect(isSpacingRhythmMultiple(21)).toBe(false);
    expect(isSpacingRhythmMultiple(-4)).toBe(false);
    expect(calculateSpacingRhythmCoordinates(5, 17, 1)).toEqual([5, 9, 13, 17]);
  });

  it('compares members of one semantic row against the same line', () => {
    expect(
      evaluateSemanticBaselineGroup({
        name: 'sidebar-row',
        mode: 'text',
        members: [
          { name: 'title', coordinate: 40 },
          { name: 'time', coordinate: 40.25 },
        ],
      }).aligned
    ).toBe(true);
    expect(
      evaluateSemanticBaselineGroup({
        name: 'sidebar-row',
        mode: 'text',
        members: [
          { name: 'title', coordinate: 40 },
          { name: 'time', coordinate: 42 },
        ],
      })
    ).toMatchObject({
      aligned: false,
      line: 41,
      spread: 2,
      members: [{ delta: 1 }, { delta: 1 }],
    });
  });

  it('places a text baseline guide independently of DOM order', () => {
    const members = [
      { name: 'title', coordinate: 42 },
      { name: 'time', coordinate: 40 },
      { name: 'diff', coordinate: 41 },
    ];

    expect(
      evaluateSemanticBaselineGroup({ name: 'sidebar-row', mode: 'text', members })
    ).toMatchObject({ line: 41, spread: 2, aligned: false });
    expect(
      evaluateSemanticBaselineGroup({
        name: 'sidebar-row',
        mode: 'text',
        members: [...members].reverse(),
      })
    ).toMatchObject({ line: 41, spread: 2, aligned: false });
  });

  it('compares repeated semantic slots on either axis without trusting DOM order', () => {
    const result = evaluateSemanticAlignmentGroup({
      name: 'sidebar.primary-trailing-rail-end',
      instance: null,
      axis: 'x',
      anchor: 'inline-end',
      policy: 'observe',
      minMembers: 3,
      tolerance: 0.5,
      members: [
        { name: 'project-action', coordinate: 276 },
        { name: 'section-action', coordinate: 280 },
        { name: 'session-action', coordinate: 280 },
      ],
    });

    expect(result).toMatchObject({
      line: 280,
      spread: 4,
      measurable: true,
      aligned: false,
    });
    expect(result.members).toEqual([
      { name: 'project-action', coordinate: 276, delta: 4 },
      { name: 'section-action', coordinate: 280, delta: 0 },
      { name: 'session-action', coordinate: 280, delta: 0 },
    ]);
  });

  it('does not vacuously pass a declared semantic line with too few members', () => {
    expect(
      evaluateSemanticAlignmentGroup({
        name: 'sidebar.row.content-center',
        instance: 'sidebar-session:one',
        axis: 'y',
        anchor: 'block-center',
        policy: 'observe',
        minMembers: 2,
        tolerance: 0.5,
        members: [{ name: 'title', coordinate: 40 }],
      })
    ).toMatchObject({ measurable: false, aligned: false });
  });

  it('classifies sub-pixel spread separately from actionable violations', () => {
    expect(
      evaluateSemanticAlignmentGroup({
        name: 'sidebar.row.visual-center',
        instance: 'row-1',
        axis: 'y',
        anchor: 'visual-center',
        minMembers: 2,
        tolerance: 0.5,
        policy: 'observe',
        members: [
          { name: 'icon', coordinate: 40 },
          { name: 'label', coordinate: 40.75 },
        ],
      })
    ).toMatchObject({
      measurable: true,
      aligned: false,
      spread: 0.75,
      status: 'sub-pixel-jitter',
    });
  });

  it('snaps semantic coordinates to the capture physical-pixel grid', () => {
    expect(
      evaluateSemanticAlignmentGroup({
        name: 'sidebar.row.visual-center',
        instance: 'row-1',
        axis: 'y',
        anchor: 'visual-center',
        minMembers: 2,
        tolerance: 0.5,
        policy: 'observe',
        deviceScaleFactor: 2,
        members: [
          { name: 'icon', coordinate: 40.24 },
          { name: 'label', coordinate: 40.26 },
        ],
      })
    ).toMatchObject({
      line: 40.25,
      spread: 0.5,
      status: 'aligned',
      members: [{ coordinate: 40 }, { coordinate: 40.5 }],
    });
  });

  it('marks a single-member baseline as insufficient evidence', () => {
    expect(
      evaluateSemanticBaselineGroup({
        name: 'sidebar-row',
        mode: 'text',
        members: [{ name: 'title', coordinate: 40 }],
      })
    ).toMatchObject({
      measurable: false,
      aligned: false,
      spread: 0,
      status: 'insufficient-evidence',
    });
  });

  it('discovers a repeated rail and identifies a two-pixel outlier', () => {
    const result = discoverAlignmentRails(
      [322, 322, 322, 324, 322, 322].map((coordinate, index) => ({
        elementId: `child-${index + 1}`,
        rowId: `row-${index + 1}`,
        anchor: 'inline-end' as const,
        coordinate,
        yStart: index * 32,
        yEnd: index * 32 + 20,
      }))
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      anchor: 'inline-end',
      line: 322,
      support: 5,
      sampleSize: 6,
      confidence: 5 / 6,
      outliers: [{ elementId: 'child-4', coordinate: 324, delta: 2, outlier: true }],
    });
  });

  it('partitions rails by coordinate independently of DOM order', () => {
    const candidates = [
      { coordinate: 103, rowId: 'right-2', yStart: 50 },
      { coordinate: 100, rowId: 'left-3', yStart: 90 },
      { coordinate: 103, rowId: 'right-1', yStart: 10 },
      { coordinate: 100, rowId: 'left-1', yStart: 20 },
      { coordinate: 103, rowId: 'right-3', yStart: 80 },
      { coordinate: 100, rowId: 'left-2', yStart: 60 },
    ].map(({ coordinate, rowId, yStart }) => ({
      elementId: rowId,
      rowId,
      anchor: 'inline-start' as const,
      coordinate,
      yStart,
      yEnd: yStart + 20,
    }));

    const forward = discoverAlignmentRails(candidates);
    const reversed = discoverAlignmentRails([...candidates].reverse());

    expect(forward.map((rail) => rail.line).sort()).toEqual([100, 103]);
    expect(reversed).toEqual(forward);
  });

  it('keeps repeated indentation modes separate across intermediate coordinates', () => {
    const candidates = [
      ...[0, 40, 80].map((yStart, index) => ({
        elementId: `body-${index + 1}`,
        rowId: `body-row-${index + 1}`,
        coordinate: 100,
        yStart,
      })),
      {
        elementId: 'intermediate-control',
        rowId: 'intermediate-row',
        coordinate: 108,
        yStart: 120,
      },
      ...[160, 200, 240].map((yStart, index) => ({
        elementId: `indented-${index + 1}`,
        rowId: `indented-row-${index + 1}`,
        coordinate: 116,
        yStart,
      })),
    ].map((candidate) => ({
      ...candidate,
      anchor: 'inline-start' as const,
      yEnd: candidate.yStart + 20,
    }));

    const rails = discoverAlignmentRails(candidates, { mergeTolerance: 12 });

    expect(rails.map((rail) => rail.line).sort((left, right) => left - right)).toEqual([100, 116]);
    expect(rails.find((rail) => rail.line === 100)?.outliers).toEqual([
      expect.objectContaining({ elementId: 'intermediate-control', delta: 8 }),
    ]);
    expect(rails.find((rail) => rail.line === 116)?.outliers).toEqual([]);
  });

  it('recognizes a two-row local indentation rail', () => {
    const candidates = [
      ...[0, 40, 80].map((yStart, index) => ({
        elementId: `body-${index + 1}`,
        rowId: `body-row-${index + 1}`,
        coordinate: 100,
        yStart,
      })),
      ...[120, 152].map((yStart, index) => ({
        elementId: `status-${index + 1}`,
        rowId: `status-row-${index + 1}`,
        coordinate: 96,
        yStart,
      })),
    ].map((candidate) => ({
      ...candidate,
      anchor: 'inline-start' as const,
      yEnd: candidate.yStart + 20,
    }));

    const rails = discoverAlignmentRails(candidates, {
      mergeTolerance: 8,
      minSupport: 2,
    });

    expect(rails.map((rail) => rail.line).sort((left, right) => left - right)).toEqual([96, 100]);
    expect(rails.every((rail) => rail.outliers.length === 0)).toBe(true);
  });

  it('keeps adjacent repeated visual levels separate at one pixel', () => {
    const candidates = [
      ...[0, 160, 320].map((yStart, index) => ({
        elementId: `section-copy-${index + 1}`,
        rowId: `section-copy-row-${index + 1}`,
        coordinate: 100,
        yStart,
      })),
      ...[32, 64, 96, 192, 224, 256].map((yStart, index) => ({
        elementId: `table-cell-${index + 1}`,
        rowId: `table-cell-row-${index + 1}`,
        coordinate: 101,
        yStart,
      })),
    ].map((candidate) => ({
      ...candidate,
      kind: 'text',
      anchor: 'inline-start' as const,
      yEnd: candidate.yStart + 20,
    }));

    const rails = discoverAlignmentRails(candidates, {
      mergeTolerance: 8,
      minSupport: 2,
    });

    expect(rails.map((rail) => rail.line).sort((left, right) => left - right)).toEqual([100, 101]);
    expect(rails.every((rail) => rail.outliers.length === 0)).toBe(true);
  });

  it('does not attach an unrelated icon to a text-only rail', () => {
    const rails = discoverAlignmentRails(
      [
        ...[0, 32, 64].map((yStart, index) => ({
          elementId: `text-${index + 1}`,
          rowId: `text-row-${index + 1}`,
          kind: 'text',
          coordinate: 100,
          yStart,
        })),
        {
          elementId: 'nearby-icon',
          rowId: 'icon-row',
          kind: 'svg',
          coordinate: 106,
          yStart: 96,
        },
      ].map((candidate) => ({
        ...candidate,
        anchor: 'inline-start' as const,
        yEnd: candidate.yStart + 20,
      })),
      { mergeTolerance: 8 }
    );

    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({ line: 100, support: 3, sampleSize: 3, outliers: [] });
  });

  it('does not attach a layout box to a nearby ink rail', () => {
    const rails = discoverAlignmentRails(
      [
        ...[0, 32, 64].map((yStart, index) => ({
          elementId: `visible-label-${index + 1}`,
          rowId: `text-row-${index + 1}`,
          kind: 'text',
          space: 'ink' as const,
          coordinate: 26,
          yStart,
        })),
        {
          elementId: 'section-hit-target',
          rowId: 'section-row',
          kind: 'button',
          space: 'layout-box' as const,
          coordinate: 17,
          yStart: 96,
        },
      ].map((candidate) => ({
        ...candidate,
        anchor: 'inline-start' as const,
        yEnd: candidate.yStart + 20,
      })),
      { mergeTolerance: 12 }
    );

    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({
      space: 'ink',
      line: 26,
      support: 3,
      sampleSize: 3,
      outliers: [],
    });
  });

  it('keeps distant visual regions eligible for a nearby rail', () => {
    const rails = discoverAlignmentRails(
      [
        ...[100, 140, 180].map((yStart, index) => ({
          elementId: `list-item-${index + 1}`,
          rowId: `list-row-${index + 1}`,
          coordinate: 100,
          yStart,
        })),
        {
          elementId: 'unrelated-footer',
          rowId: 'footer-row',
          coordinate: 108,
          yStart: 500,
        },
      ].map((candidate) => ({
        ...candidate,
        anchor: 'inline-start' as const,
        yEnd: candidate.yStart + 20,
      })),
      { mergeTolerance: 12 }
    );

    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({
      line: 100,
      support: 3,
      sampleSize: 4,
      outliers: [{ elementId: 'unrelated-footer', coordinate: 108, delta: 8, outlier: true }],
    });
  });

  it('scores vertical coverage relative to the containing scope', () => {
    const rails = discoverAlignmentRails(
      [0, 20, 40].map((yStart, index) => ({
        elementId: `child-${index + 1}`,
        rowId: `row-${index + 1}`,
        anchor: 'inline-start' as const,
        coordinate: 100,
        yStart,
        yEnd: yStart + 10,
      })),
      { minVerticalSpan: 0, scopeHeight: 100 }
    );

    expect(rails[0]).toMatchObject({ verticalSpan: 50, confidence: 0.5 });
  });

  it('does not infer center rails from flow-text boxes', () => {
    const candidates: AlignmentRailCandidate[] = ['text', 'button'].flatMap((kind, groupIndex) =>
      [0, 1, 2].map((index) => ({
        elementId: `${kind}-${index + 1}`,
        rowId: `${kind}-row-${index + 1}`,
        kind,
        anchor: 'inline-center' as const,
        coordinate: groupIndex === 0 ? 100 : 200,
        yStart: index * 32,
        yEnd: index * 32 + 20,
      }))
    );

    expect(discoverAlignmentRails(candidates)).toEqual([
      expect.objectContaining({
        anchor: 'inline-center',
        line: 200,
        support: 3,
        sampleSize: 3,
      }),
    ]);
  });

  it('lets centered text contribute only its center coordinate', () => {
    const candidates: AlignmentRailCandidate[] = [
      'inline-start',
      'inline-center',
      'inline-end',
    ].map((anchor, index) => ({
      elementId: `centered-${index}`,
      rowId: `row-${index}`,
      kind: 'text',
      alignmentMode: 'centered',
      anchor: anchor as AlignmentRailCandidate['anchor'],
      coordinate: 100,
      yStart: index * 32,
      yEnd: index * 32 + 20,
    }));

    expect(discoverAlignmentRails(candidates, { minSupport: 2, minVerticalSpan: 0 })).toEqual([]);
  });

  it('rejects a two-support rail that crosses visual partitions', () => {
    const candidates: AlignmentRailCandidate[] = [
      {
        elementId: 'heading',
        rowId: 'heading-row',
        sectionId: 'hero',
        kind: 'text',
        anchor: 'inline-start',
        coordinate: 100,
        yStart: 0,
        yEnd: 20,
      },
      {
        elementId: 'chip',
        rowId: 'chip-row',
        sectionId: 'composer',
        kind: 'text',
        anchor: 'inline-start',
        coordinate: 100,
        yStart: 800,
        yEnd: 820,
      },
    ];

    expect(discoverAlignmentRails(candidates, { minSupport: 2 })).toEqual([]);
  });

  it('requires mixed-kind supporters to share one row family', () => {
    const makeCandidates = (rowFamily: readonly string[]): AlignmentRailCandidate[] => [
      {
        elementId: 'heading',
        rowId: 'heading-row',
        rowFamily: rowFamily[0],
        kind: 'text',
        anchor: 'inline-start',
        coordinate: 100,
        yStart: 0,
        yEnd: 20,
      },
      {
        elementId: 'icon',
        rowId: 'icon-row',
        rowFamily: rowFamily[1],
        kind: 'svg',
        anchor: 'inline-start',
        coordinate: 100,
        yStart: 32,
        yEnd: 52,
      },
    ];

    expect(
      discoverAlignmentRails(makeCandidates(['hero', 'composer']), {
        minSupport: 2,
        minVerticalSpan: 0,
      })
    ).toEqual([]);
    expect(
      discoverAlignmentRails(makeCandidates(['sidebar-row', 'sidebar-row']), {
        minSupport: 2,
        minVerticalSpan: 0,
      })
    ).toHaveLength(1);
  });

  it('collapses repeated slot anchors to the boundary-facing canonical rail', () => {
    const slots = [
      { id: 'section-action', left: 219, right: 267 },
      { id: 'project-action', left: 242, right: 262 },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `session-action-${index + 1}`,
        left: 246,
        right: 266,
      })),
      { id: 'new-session-action', left: 251, right: 275 },
    ];
    const candidates: AlignmentRailCandidate[] = slots.flatMap((slot, index) => {
      const common = {
        elementId: slot.id,
        rowId: `row-${index + 1}`,
        kind: 'button',
        yStart: index * 40,
        yEnd: index * 40 + 20,
      };
      return [
        { ...common, anchor: 'inline-start' as const, coordinate: slot.left },
        {
          ...common,
          anchor: 'inline-center' as const,
          coordinate: (slot.left + slot.right) / 2,
        },
        { ...common, anchor: 'inline-end' as const, coordinate: slot.right },
      ];
    });

    const rails = selectCanonicalAlignmentRails(
      discoverAlignmentRails(candidates, { mergeTolerance: 12 }),
      { x: 17, y: 0, width: 258, height: 400 }
    );

    expect(rails).toHaveLength(1);
    expect(rails[0]).toMatchObject({
      anchor: 'inline-end',
      line: 266,
      support: 5,
      sampleSize: 8,
      outliers: [
        { elementId: 'section-action', coordinate: 267, delta: 1 },
        { elementId: 'project-action', coordinate: 262, delta: 4 },
        { elementId: 'new-session-action', coordinate: 275, delta: 9 },
      ],
    });
  });

  it('selects the trailing edge for repeated numeric text', () => {
    const rows = [
      { id: 'one-digit', left: 80, right: 100 },
      { id: 'two-digits', left: 72, right: 100 },
      { id: 'three-digits', left: 64, right: 100 },
    ];
    const candidates: AlignmentRailCandidate[] = rows.flatMap((row, index) => {
      const common = {
        elementId: row.id,
        rowId: `row-${index + 1}`,
        kind: 'numeric-text',
        yStart: index * 32,
        yEnd: index * 32 + 20,
      };
      return [
        { ...common, anchor: 'inline-start' as const, coordinate: row.left },
        { ...common, anchor: 'inline-end' as const, coordinate: row.right },
      ];
    });

    const rails = selectCanonicalAlignmentRails(discoverAlignmentRails(candidates), {
      x: 0,
      y: 0,
      width: 120,
      height: 120,
    });

    expect(rails).toEqual([
      expect.objectContaining({
        anchor: 'inline-end',
        line: 100,
        support: 3,
        outliers: [],
      }),
    ]);
  });

  it('does not let nested boxes on one row manufacture rail support', () => {
    const result = discoverAlignmentRails(
      [
        {
          elementId: 'row-one-wrapper',
          rowId: 'row-one',
          anchor: 'inline-start' as const,
          coordinate: 42,
          yStart: 0,
          yEnd: 20,
        },
        {
          elementId: 'row-one-text',
          rowId: 'row-one',
          anchor: 'inline-start' as const,
          coordinate: 42,
          yStart: 2,
          yEnd: 18,
        },
        {
          elementId: 'row-two-text',
          rowId: 'row-two',
          anchor: 'inline-start' as const,
          coordinate: 42,
          yStart: 32,
          yEnd: 52,
        },
      ],
      { minSupport: 3 }
    );

    expect(result).toEqual([]);
  });

  it('discovers repeated sibling subtrees as automatic layout scopes', () => {
    const nodes: LayoutTopologyNode[] = [
      {
        id: 'list',
        parentId: null,
        order: 0,
        depth: 0,
        tag: 'div',
        role: 'list',
        candidateKind: null,
        rect: { x: 20, y: 20, width: 280, height: 160 },
      },
    ];
    for (let index = 0; index < 4; index += 1) {
      const rowId = `row-${index + 1}`;
      nodes.push(
        {
          id: rowId,
          parentId: 'list',
          order: index,
          depth: 1,
          tag: 'div',
          role: 'listitem',
          candidateKind: null,
          rect: { x: 20, y: 20 + index * 40, width: 280, height: 32 },
        },
        {
          id: `${rowId}-icon`,
          parentId: rowId,
          order: 0,
          depth: 2,
          tag: 'svg',
          role: null,
          candidateKind: 'svg',
          rect: { x: 32, y: 28 + index * 40, width: 16, height: 16 },
        },
        {
          id: `${rowId}-label`,
          parentId: rowId,
          order: 1,
          depth: 2,
          tag: 'span',
          role: null,
          candidateKind: 'text',
          rect: { x: 60, y: 26 + index * 40, width: 160, height: 20 },
        }
      );
    }

    expect(discoverRepeatedLayoutScopes(nodes)).toEqual([
      expect.objectContaining({
        parentId: 'list',
        instanceIds: ['row-1', 'row-2', 'row-3', 'row-4'],
        similarity: 1,
        confidence: 1,
      }),
    ]);
  });

  it('does not mistake one horizontal toolbar for repeated rows', () => {
    const nodes: LayoutTopologyNode[] = [
      {
        id: 'toolbar',
        parentId: null,
        order: 0,
        depth: 0,
        tag: 'div',
        role: 'toolbar',
        candidateKind: null,
        rect: { x: 20, y: 20, width: 200, height: 32 },
      },
      ...[0, 1, 2].map(
        (index): LayoutTopologyNode => ({
          id: `action-${index}`,
          parentId: 'toolbar',
          order: index,
          depth: 1,
          tag: 'button',
          role: null,
          candidateKind: 'button',
          rect: { x: 20 + index * 40, y: 20, width: 32, height: 32 },
        })
      ),
    ];

    expect(discoverRepeatedLayoutScopes(nodes)).toEqual([]);
  });

  it('infers a proposal when one topology rail survives multiple captures', () => {
    const rail = (line: number) => ({
      anchor: 'inline-start' as const,
      line,
      support: 4,
      sampleSize: 4,
      verticalSpan: 120,
      confidence: 1,
      members: [],
      outliers: [],
    });

    expect(
      inferAlignmentRailContractProposals([
        {
          captureId: 'idle-1280',
          scopeKey: 'auto:repeated-session-row',
          scopeRect: { x: 0, y: 0, width: 200, height: 400 },
          rails: [rail(40)],
        },
        {
          captureId: 'permission-1440',
          scopeKey: 'auto:repeated-session-row',
          scopeRect: { x: 100, y: 0, width: 400, height: 500 },
          rails: [rail(180)],
        },
      ])
    ).toEqual([
      expect.objectContaining({
        kind: 'alignment-rail',
        scopeKey: 'auto:repeated-session-row',
        anchor: 'inline-start',
        normalizedLine: 0.2,
        confidence: 1,
        policy: 'proposal',
        evidence: expect.objectContaining({
          captureIds: ['idle-1280', 'permission-1440'],
          captureCoverage: 1,
          support: 8,
          sampleSize: 8,
          outlierCount: 0,
          maxNormalizedResidual: 0,
        }),
      }),
    ]);
  });

  it('does not promote a rail observed in only one capture into a proposal', () => {
    expect(
      inferAlignmentRailContractProposals([
        {
          captureId: 'only-state',
          scopeKey: 'auto:one-state',
          scopeRect: { x: 0, y: 0, width: 320, height: 400 },
          rails: [
            {
              anchor: 'inline-end',
              line: 300,
              support: 5,
              sampleSize: 5,
              verticalSpan: 160,
              confidence: 1,
              members: [],
              outliers: [],
            },
          ],
        },
      ])
    ).toEqual([]);
  });

  it('chooses one canonical anchor from family evidence across captures', () => {
    const family = (kinds: readonly string[]) => {
      const rail = (anchor: 'inline-start' | 'inline-center' | 'inline-end', line: number) => ({
        anchor,
        line,
        support: kinds.length,
        sampleSize: kinds.length,
        verticalSpan: 100,
        confidence: 1,
        members: kinds.map((kind, index) => ({
          elementId: `slot-${index + 1}`,
          rowId: `row-${index + 1}`,
          kind,
          anchor,
          coordinate: line,
          yStart: index * 30,
          yEnd: index * 30 + 20,
          delta: 0,
          outlier: false,
        })),
        outliers: [],
      });
      return {
        rails: [rail('inline-start', 20), rail('inline-center', 50), rail('inline-end', 80)],
      };
    };
    const textMajority = family(['text', 'text', 'button']);
    const controlMajority = family(['text', 'button', 'button']);

    const proposals = inferAlignmentRailContractProposals(
      [
        {
          captureId: 'capture-a',
          scopeKey: 'sidebar:row-slot',
          scopeRect: { x: 0, y: 0, width: 100, height: 200 },
          rails: [textMajority.rails[0]!],
          railFamilies: [textMajority],
        },
        {
          captureId: 'capture-b',
          scopeKey: 'sidebar:row-slot',
          scopeRect: { x: 0, y: 0, width: 100, height: 200 },
          rails: [controlMajority.rails[2]!],
          railFamilies: [controlMajority],
        },
        {
          captureId: 'capture-c',
          scopeKey: 'sidebar:row-slot',
          scopeRect: { x: 0, y: 0, width: 100, height: 200 },
          rails: [],
          railFamilies: [],
        },
      ],
      { minConfidence: 0 }
    );

    expect(proposals).toEqual([
      expect.objectContaining({
        anchor: 'inline-start',
        normalizedLine: 0.2,
        evidence: expect.objectContaining({
          captureIds: ['capture-a', 'capture-b'],
          captureCoverage: 2 / 3,
        }),
      }),
    ]);
  });

  it('caps normalized clustering tolerance at four physical pixels', () => {
    const rail = (line: number) => ({
      anchor: 'inline-start' as const,
      line,
      support: 4,
      sampleSize: 4,
      verticalSpan: 100,
      confidence: 1,
      members: [],
      outliers: [],
    });

    expect(
      inferAlignmentRailContractProposals(
        [
          {
            captureId: 'wide-a',
            scopeKey: 'main:content',
            scopeRect: { x: 0, y: 0, width: 1000, height: 500 },
            rails: [rail(200)],
          },
          {
            captureId: 'wide-b',
            scopeKey: 'main:content',
            scopeRect: { x: 0, y: 0, width: 1000, height: 500 },
            rails: [rail(207)],
          },
        ],
        { minConfidence: 0 }
      )
    ).toEqual([]);
  });
});

describe('vertical rail discovery', () => {
  const rowMember = (
    elementId: string,
    row: number,
    coordinate: number,
    overrides: Partial<BlockRailCandidate> = {}
  ): BlockRailCandidate => ({
    elementId,
    rowId: `visual-row:${row}`,
    rowFamily: 'div[text]>div[button]',
    kind: 'text',
    space: 'ink',
    anchor: 'visual-center',
    coordinate,
    xStart: 40,
    xEnd: 220,
    yStart: coordinate - 8,
    yEnd: coordinate + 8,
    ...overrides,
  });

  it('measures a row against its own median and reports the member that leaves it', () => {
    const [rail] = discoverBlockAlignmentRails([
      rowMember('icon', 1, 42, { kind: 'svg', xStart: 20, xEnd: 32 }),
      rowMember('title', 1, 40),
      rowMember('time', 1, 40, { xStart: 240, xEnd: 262 }),
    ]);

    expect(rail).toMatchObject({ anchor: 'visual-center', line: 40, support: 2, sampleSize: 3 });
    expect(rail?.outliers.map((member) => member.elementId)).toEqual(['icon']);
    expect(rail?.outliers[0]?.delta).toBe(2);
  });

  it('never lets one row establish another row\u2019s vertical line', () => {
    const rails = discoverBlockAlignmentRails([
      rowMember('title-a', 1, 40),
      rowMember('icon-a', 1, 40, { kind: 'svg' }),
      rowMember('title-b', 2, 72),
      rowMember('icon-b', 2, 74, { kind: 'svg' }),
    ]);

    expect(rails.map((rail) => rail.rowId)).toEqual(['visual-row:1', 'visual-row:2']);
    expect(rails[0]?.outliers).toEqual([]);
    // The second row is judged against 73, its own median, not against row one.
    expect(rails[1]?.line).toBe(73);
    expect(rails[1]?.outliers).toHaveLength(2);
  });

  it('compares a block edge only between primitives of one kind', () => {
    const mixed = discoverBlockAlignmentRails([
      rowMember('icon', 1, 36, { kind: 'svg', anchor: 'block-start' }),
      rowMember('title', 1, 32, { anchor: 'block-start' }),
    ]);
    const sameKind = discoverBlockAlignmentRails([
      rowMember('title', 1, 32, { anchor: 'block-start' }),
      rowMember('time', 1, 36, { anchor: 'block-start' }),
    ]);

    expect(mixed).toEqual([]);
    expect(sameKind).toHaveLength(1);
  });

  it('snaps to the physical pixel grid before deciding what left the line', () => {
    const [rail] = discoverBlockAlignmentRails(
      [
        rowMember('title', 1, 40.1),
        rowMember('time', 1, 40.1),
        rowMember('icon', 1, 40.3, { kind: 'svg' }),
      ],
      { deviceScaleFactor: 2 }
    );

    expect(rail?.line).toBe(40);
    expect(rail?.outliers).toEqual([]);
  });

  it('does not report a row that renders a single measurable primitive', () => {
    expect(discoverBlockAlignmentRails([rowMember('title', 1, 40)])).toEqual([]);
  });

  it('refuses to call the distance between two lines of one block a misalignment', () => {
    // A composer label above its textarea is captured as one visual row, but
    // neither box reaches the other's centre: they are two lines, not one.
    const stacked = discoverBlockAlignmentRails([
      rowMember('label', 1, 608, { yStart: 600, yEnd: 617 }),
      rowMember('textarea', 1, 647, { kind: 'field', yStart: 623, yEnd: 671 }),
    ]);
    expect(stacked).toEqual([]);

    // The same row with a third primitive on the label's line still reports
    // that line, and the far primitive is simply not on it.
    const [rail] = discoverBlockAlignmentRails([
      rowMember('label', 1, 608, { yStart: 600, yEnd: 617 }),
      rowMember('hint', 1, 610, { yStart: 601, yEnd: 618 }),
      rowMember('textarea', 1, 647, { kind: 'field', yStart: 623, yEnd: 671 }),
    ]);
    expect(rail?.members.map((member) => member.elementId)).toEqual(['label', 'hint']);
    expect(rail?.line).toBe(609);
  });

  it('reports a thin glyph that moved, instead of dropping it off the line', () => {
    // An ellipsis icon is about a pixel of ink: its own extent stops containing
    // the line as soon as it moves at all, so the row band has to carry it.
    const [rail] = discoverBlockAlignmentRails([
      rowMember('title', 1, 40, { yStart: 32, yEnd: 48 }),
      rowMember('time', 1, 40, { yStart: 33, yEnd: 47 }),
      rowMember('ellipsis', 1, 43, { kind: 'svg', yStart: 42.4, yEnd: 43.6 }),
    ]);

    expect(rail?.line).toBe(40);
    expect(rail?.sampleSize).toBe(3);
    expect(rail?.outliers.map((member) => member.elementId)).toEqual(['ellipsis']);
  });

  it('still reports a member that moved but stays on the line', () => {
    const [rail] = discoverBlockAlignmentRails([
      rowMember('title', 1, 40, { yStart: 32, yEnd: 48 }),
      rowMember('time', 1, 40, { yStart: 32, yEnd: 48 }),
      rowMember('icon', 1, 43, { kind: 'svg', yStart: 37, yEnd: 49 }),
    ]);

    expect(rail?.line).toBe(40);
    expect(rail?.outliers.map((member) => member.elementId)).toEqual(['icon']);
    expect(rail?.outliers[0]?.delta).toBe(3);
  });
});

describe('chat workspace validation', () => {
  it('accepts the expanded Sidebar + Main Pane + Chat Landing geometry', () => {
    expect(
      validateChatWorkspaceGeometry(expandedWorkspaceSnapshot(), {
        sidebar: 'expanded',
        spacingMeasurements: [
          { name: 'greeting.gap', value: 20 },
          { name: 'composer.padding-bottom', value: 8 },
        ],
      })
    ).toEqual([]);
  });

  it('accepts a collapsed sidebar only when the main pane fills the shell', () => {
    const snapshot = expandedWorkspaceSnapshot();
    const fullPane = { x: 0, y: 0, width: 1440, height: 900 };
    snapshot[anchors.mainPane] = fullPane;
    snapshot[anchors.chatLanding] = fullPane;
    snapshot[anchors.greetingRegion] = { x: 0, y: 0, width: 1440, height: 668 };
    snapshot[anchors.composerBand] = { x: 0, y: 668, width: 1440, height: 232 };
    snapshot[anchors.conversationColumn] = { x: 352, y: 668, width: 736, height: 224 };
    delete snapshot[anchors.sidebarSlot];
    delete snapshot[anchors.sidebarCard];

    expect(validateChatWorkspaceGeometry(snapshot, { sidebar: 'collapsed' })).toEqual([]);
  });

  it('reports stable, actionable violations for missing and drifting anchors', () => {
    const snapshot = expandedWorkspaceSnapshot();
    delete snapshot[anchors.greetingRegion];
    snapshot[anchors.sidebarCard] = { x: 10, y: 8, width: 280, height: 884 };
    snapshot[anchors.conversationColumn] = { x: 500, y: 668, width: 730, height: 224 };

    const violations = validateChatWorkspaceGeometry(snapshot, { sidebar: 'expanded' });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-anchor', path: anchors.greetingRegion }),
        expect.objectContaining({
          code: 'edge-alignment',
          path: `${anchors.sidebarCard}.leftInset`,
        }),
        expect.objectContaining({
          code: 'horizontal-centering',
          path: `${anchors.conversationColumn}.centerX`,
        }),
        expect.objectContaining({
          code: 'expected-width',
          path: `${anchors.conversationColumn}.width`,
        }),
      ])
    );
  });

  it('validates declared grid placements and baseline measurements', () => {
    const snapshot = expandedWorkspaceSnapshot();
    snapshot[anchors.greetingRegion] = { x: 324, y: 0, width: 160, height: 668 };

    const violations = validateChatWorkspaceGeometry(snapshot, {
      sidebar: 'expanded',
      gridPlacements: [{ anchor: anchors.greetingRegion, start: 2, span: 4 }],
      spacingMeasurements: [{ name: 'greeting.gap', value: 18 }],
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'grid-placement' }),
        expect.objectContaining({
          code: 'spacing-rhythm',
          path: 'greeting.gap',
          actual: 18,
        }),
      ])
    );
  });

  it('rejects invalid rectangles before comparing their edges', () => {
    const snapshot = expandedWorkspaceSnapshot();
    snapshot[anchors.mainPane] = { x: Number.NaN, y: 0, width: 1148, height: 900 };

    const violations = validateChatWorkspaceGeometry(snapshot, { sidebar: 'expanded' });

    expect(violations).toContainEqual(
      expect.objectContaining({ code: 'invalid-rect', path: anchors.mainPane })
    );
    expect(violations.some((violation) => violation.path.startsWith(`${anchors.mainPane}.`))).toBe(
      false
    );
  });

  it('reports an unsupported narrow pane without throwing from validation', () => {
    const snapshot: ChatWorkspaceGeometrySnapshot = {
      [anchors.workspaceShell]: { x: 0, y: 0, width: 60, height: 400 },
      [anchors.mainPane]: { x: 0, y: 0, width: 60, height: 400 },
      [anchors.chatLanding]: { x: 0, y: 0, width: 60, height: 400 },
      [anchors.greetingRegion]: { x: 0, y: 0, width: 60, height: 300 },
      [anchors.composerBand]: { x: 0, y: 300, width: 60, height: 100 },
      [anchors.conversationColumn]: { x: 0, y: 300, width: 60, height: 92 },
    };

    expect(validateChatWorkspaceGeometry(snapshot, { sidebar: 'collapsed' })).toContainEqual(
      expect.objectContaining({
        code: 'width-range',
        path: `${anchors.mainPane}.width`,
      })
    );
  });
});

describe('what belongs to a visual row', () => {
  it('rejects a composer label stacked above its field', () => {
    // The real composer: a 18px `label` sitting directly above a 48px field,
    // both children of one 48px-tall wrapper. Calling that a row makes the
    // leading between the two lines a 25px vertical misalignment.
    const label = { top: 806, bottom: 824 };
    const field = { top: 803, bottom: 851 };
    const rowCenter = (Math.min(label.top, field.top) + Math.max(label.bottom, field.bottom)) / 2;

    expect(selectVisualRowSlots([label, field], rowCenter)).toEqual([1]);
  });

  it('keeps every slot of a real row, however differently sized', () => {
    const icon = { top: 104, bottom: 120 };
    const title = { top: 102, bottom: 122 };
    const trailingButton = { top: 96, bottom: 128 };
    const rowCenter = 112;

    expect(selectVisualRowSlots([icon, title, trailingButton], rowCenter)).toEqual([0, 1, 2]);
  });

  it('drops a badge that sits a line above the row it shares a box with', () => {
    const badge = { top: 100, bottom: 116 };
    const text = { top: 130, bottom: 146 };
    const rowCenter = 123;

    // Neither slot reaches the other's line, so the proposal has fewer than two
    // members left and is not a row at all.
    expect(selectVisualRowSlots([badge, text], rowCenter).length).toBeLessThan(2);
  });
});

describe('painted CSS shapes are primitives', () => {
  const shape = (overrides: Partial<Parameters<typeof isGeometryPaintedShape>[0]> = {}) => ({
    width: 8,
    height: 8,
    renderedChildCount: 0,
    text: '',
    backgroundColor: 'rgb(34 197 94)',
    backgroundImage: 'none',
    borderWidths: [0, 0, 0, 0],
    borderColors: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'],
    ...overrides,
  });

  it('sees the sidebar status dot', () => {
    expect(isGeometryPaintedShape(shape())).toBe(true);
    expect(isGeometryPaintedShape(shape({ backgroundColor: 'rgb(34 197 94 / 0.4)' }))).toBe(true);
    expect(
      isGeometryPaintedShape(
        shape({
          backgroundColor: 'rgba(0, 0, 0, 0)',
          borderWidths: [1, 1, 1, 1],
          borderColors: ['rgb(0 0 0)', 'rgb(0 0 0)', 'rgb(0 0 0)', 'rgb(0 0 0)'],
        })
      )
    ).toBe(true);
  });

  it('is not a surface, a spacer or something with contents', () => {
    // A page-wide separator is layout, not a mark a row aligns against.
    expect(isGeometryPaintedShape(shape({ width: 240, height: 1 }))).toBe(false);
    expect(isGeometryPaintedShape(shape({ backgroundColor: 'rgba(0, 0, 0, 0)' }))).toBe(false);
    expect(isGeometryPaintedShape(shape({ backgroundColor: 'transparent' }))).toBe(false);
    expect(isGeometryPaintedShape(shape({ renderedChildCount: 1 }))).toBe(false);
    expect(isGeometryPaintedShape(shape({ text: '3' }))).toBe(false);
    expect(isGeometryPaintedShape(shape({ width: 0 }))).toBe(false);
  });
});

describe('the canvas font string', () => {
  it('leaves the computed font-variant out, which a canvas would refuse', () => {
    const style = {
      fontStyle: 'normal',
      fontVariant: 'tabular-nums',
      fontWeight: '600',
      fontSize: '13px',
      fontFamily: 'Inter, sans-serif',
    };

    expect(geometryCanvasFontString(style)).toBe('normal 600 13px Inter, sans-serif');
    expect(geometryCanvasFontString(style)).not.toContain('tabular-nums');
  });
});
