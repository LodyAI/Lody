import { describe, expect, it } from 'vitest';

import {
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  calculateSpacingRhythmCoordinates,
  calculateGridPlacementRect,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  discoverAlignmentRails,
  discoverRepeatedLayoutScopes,
  inferAlignmentRailContractProposals,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  isSpacingRhythmMultiple,
  resolveConversationHorizontalInset,
  resolveMainPaneGridRange,
  selectCanonicalAlignmentRails,
  validateChatWorkspaceGeometry,
  type AlignmentRailCandidate,
  type ChatWorkspaceGeometrySnapshot,
  type LayoutTopologyNode,
} from '../src/lib/chat-workspace-geometry';

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
