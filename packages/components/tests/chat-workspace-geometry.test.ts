import { describe, expect, it } from 'vitest';

import {
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  calculateSpacingRhythmCoordinates,
  calculateGridPlacementRect,
  calculateMainPaneGrid,
  calculateSidebarGrid,
  evaluateSemanticAlignmentGroup,
  evaluateSemanticBaselineGroup,
  isSpacingRhythmMultiple,
  resolveConversationHorizontalInset,
  resolveMainPaneGridRange,
  validateChatWorkspaceGeometry,
  type ChatWorkspaceGeometrySnapshot,
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
