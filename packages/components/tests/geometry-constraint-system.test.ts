import { describe, expect, it } from 'vitest';

import {
  alignmentFindingKey,
  assessGeometryMarkerRemoval,
  classifyGeometryOffsetExplanation,
  compareMarkerAlignmentsToBlockRails,
  collectAggregatedGeometryRowFamilies,
  collectRepeatedGeometryRowFamilies,
  compileGeometryContracts,
  computeGeometryQualityMetrics,
  createGeometryFindings,
  diffGeometryFindings,
  evaluateGeometryContractResolutions,
  evaluateGeometryContractValues,
  explainGeometryOffset,
  geometryFindingLabel,
  geometryIdentityLocator,
  geometryRowFamilyKey,
  geometryScopeContentHash,
  isGeometryDataBearingName,
  observeGeometryCaptures,
  matchRekeyedGeometryFindings,
  resolveGeometryDesignToken,
  selectGeometryVerdictAnchor,
  summarizeGeometryInkCenters,
  triageGeometryFindings,
  type GeometryCapture,
  type GeometryCapturedBlockCandidate,
  type GeometryCapturedCandidate,
  type GeometryCapturedScope,
  type GeometryContract,
  type GeometryFinding,
  type GeometryLedger,
} from '../src/lib/geometry-constraint-system';

const locator = (name: string) => ({
  role: 'button',
  name,
  landmark: { role: 'complementary', name: 'Workspace' },
});

function candidate(
  name: string,
  primitiveId: string,
  row: number,
  coordinate: number
): GeometryCapturedCandidate {
  return {
    elementId: `button:${name}`,
    primitiveId,
    locator: locator(name),
    label: name,
    rowId: `row-${row}`,
    kind: 'svg',
    space: 'ink',
    anchor: 'inline-end',
    coordinate,
    yStart: row * 32,
    yEnd: row * 32 + 16,
  };
}

function scope(
  key: string,
  identity: string,
  width: number,
  candidates: readonly GeometryCapturedCandidate[]
): GeometryCapturedScope {
  return {
    key,
    identity,
    source: 'hint',
    depth: key === 'child' ? 4 : 2,
    rect: { x: 0, y: 0, width, height: 200 },
    candidates,
  };
}

const railCandidates = (suffix = '') => [
  candidate('First', `one${suffix}`, 0, 100),
  candidate('Second', `two${suffix}`, 1, 100),
  candidate('Third', `three${suffix}`, 2, 100),
  candidate('Shifted', `shifted${suffix}`, 3, 104),
];

function capture(captureId: string, scopes: readonly GeometryCapturedScope[]): GeometryCapture {
  return {
    captureId,
    surfaceFamily: 'workspace',
    surface: 'Workspace / Landing',
    storyId: 'geometry--landing',
    viewport: { width: 200, height: 200 },
    deviceScaleFactor: 2,
    screenshot: `assets/${captureId}.png`,
    scopes,
  };
}

describe('geometry constraint artifacts', () => {
  it('hashes rendered primitive facts independently of DOM ordinals', () => {
    const first = scope('first', 'sidebar', 200, railCandidates('-a'));
    const second = scope('second', 'sidebar', 200, railCandidates('-b'));

    expect(geometryScopeContentHash(first, 2)).toBe(geometryScopeContentHash(second, 2));
  });

  it('reuses byte-identical observations across captures', () => {
    const observations = observeGeometryCaptures({
      version: 1,
      captures: [
        capture('one', [scope('sidebar-one', 'sidebar', 200, railCandidates('-a'))]),
        capture('two', [scope('sidebar-two', 'sidebar', 200, railCandidates('-b'))]),
      ],
    });

    expect(observations.captures[0]?.scopes[0]?.rails).toHaveLength(1);
    expect(observations.captures[1]?.scopes[0]).toMatchObject({
      observationRef: { captureId: 'one', scopeKey: 'sidebar-one' },
    });
    expect(observations.captures[1]?.scopes[0]?.rails).toBeUndefined();
  });

  it('summarizes child rails into an aggregate parent scope', () => {
    const candidates = railCandidates();
    const observations = observeGeometryCaptures({
      version: 1,
      captures: [
        capture('one', [
          scope('ancestor', 'sidebar-shell', 240, candidates),
          scope('child', 'sidebar-list', 200, candidates.slice(0, 2)),
        ]),
      ],
    });
    const byScope = new Map(
      observations.captures[0]?.scopes.map((observation) => [observation.scopeKey, observation])
    );

    expect(byScope.get('child')).toMatchObject({ claimedPrimitiveCount: 2 });
    expect(byScope.get('ancestor')).toMatchObject({
      claimedPrimitiveCount: 4,
      rails: [expect.objectContaining({ support: 3, sampleSize: 4 })],
    });
  });

  it('merges one stable finding across captures and retains each evidence row', () => {
    const captureArtifact = {
      version: 1 as const,
      captures: [
        capture('one', [scope('sidebar-one', 'sidebar', 200, railCandidates('-a'))]),
        capture('two', [scope('sidebar-two', 'sidebar', 240, railCandidates('-b'))]),
      ],
    };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toEqual([
      expect.objectContaining({
        kind: 'alignment-rail',
        label: 'Shifted',
        offset: 4,
        captureCount: 2,
        totalCaptureCount: 2,
        evidence: [
          expect.objectContaining({ captureId: 'one' }),
          expect.objectContaining({ captureId: 'two' }),
        ],
      }),
    ]);
  });

  it('explains an offset as box-model arithmetic to a common ancestor', () => {
    const contribution = (padding: number, border = 0) => ({
      padding,
      border,
      margin: 0,
      gap: 0,
      layout: 0,
    });
    const withPath = (item: GeometryCapturedCandidate, inset: number, padding: number) => ({
      ...item,
      boxModelNodeRef: item.primitiveId,
      path: [
        {
          nodeId: item.primitiveId,
          parentId: 'sidebar',
          element: 'svg[img]',
          startToParent: 0,
          endToParent: inset,
          centerToParent: 0,
          inlineStart: contribution(0),
          inlineEnd: contribution(padding, inset - padding),
        },
        {
          nodeId: 'sidebar',
          element: 'aside[complementary]',
          startToParent: 0,
          endToParent: 0,
          centerToParent: 0,
          inlineStart: contribution(0),
          inlineEnd: contribution(0),
        },
      ],
    });
    const member = withPath(candidate('Member', 'member', 0, 103), 9, 8);
    const reference = withPath(candidate('Reference', 'reference', 1, 100), 12, 12);

    expect(
      explainGeometryOffset(member, reference, 'inline-end', 3, {
        ...Object.fromEntries(member.path.map((node) => [node.nodeId, node])),
        ...Object.fromEntries(reference.path.map((node) => [node.nodeId, node])),
      })
    ).toEqual({
      commonAncestor: 'aside[complementary]',
      reference: { label: 'Reference', locator: locator('Reference') },
      memberPath: {
        distance: 9,
        contribution: { padding: 8, border: 1, margin: 0, gap: 0, layout: 0 },
      },
      referencePath: {
        distance: 12,
        contribution: { padding: 12, border: 0, margin: 0, gap: 0, layout: 0 },
      },
      explainedOffset: 3,
      residual: 0,
      repair: {
        commonAncestor: 'aside[complementary]',
        edge: 'inline-end',
        terms: [
          {
            side: 'reference',
            term: 'padding',
            element: 'aside[complementary]',
            memberElement: 'aside[complementary]',
            referenceElement: 'aside[complementary]',
            memberValue: 8,
            referenceValue: 12,
            delta: -4,
          },
          {
            side: 'member',
            term: 'border',
            element: 'aside[complementary]',
            memberElement: 'aside[complementary]',
            memberValue: 1,
            referenceValue: 0,
            delta: 1,
          },
        ],
      },
    });
  });

  it('does not put a responsive rail coordinate into the finding identity', () => {
    const input = {
      surfaceFamily: 'workspace',
      locator: locator('Shifted'),
      anchor: 'inline-end' as const,
    };

    // Assigned first on purpose: a coordinate is not part of the input type at
    // all, and the assertion is that carrying one anyway cannot change a key.
    const nearLeft = { ...input, normalizedLine: 0.2 };
    const nearRight = { ...input, normalizedLine: 0.8 };

    expect(alignmentFindingKey(nearLeft)).toBe(alignmentFindingKey(nearRight));
  });

  it('classifies repeated identical instance offsets as a measurement-model divergence', () => {
    const withSemantic: GeometryCapture = {
      ...capture('semantic', []),
      semanticAlignments: ['row-one', 'row-two', 'row-three'].map((instance) => ({
        group: 'sidebar.row.visual-center',
        instance,
        axis: 'y' as const,
        anchor: 'visual-center' as const,
        status: 'sub-pixel-jitter' as const,
        line: 40.5,
        members: [
          { name: 'icon', coordinate: 40 },
          { name: 'label', coordinate: 41 },
        ],
      })),
    };
    const findings = createGeometryFindings(
      { version: 1, captures: [withSemantic] },
      { version: 1, captures: [{ captureId: 'semantic', surfaceFamily: 'workspace', scopes: [] }] }
    );

    expect(findings.findings).toEqual([
      expect.objectContaining({
        kind: 'measurement-model-divergence',
        label: 'sidebar.row.visual-center',
        evidence: expect.arrayContaining([
          expect.objectContaining({ scopeKey: 'row-one' }),
          expect.objectContaining({ scopeKey: 'row-two' }),
          expect.objectContaining({ scopeKey: 'row-three' }),
        ]),
      }),
    ]);
  });

  it('merges a measurement-model divergence across captures', () => {
    const semanticCapture = (captureId: string, instance: string): GeometryCapture => ({
      ...capture(captureId, []),
      semanticAlignments: [
        {
          group: 'sidebar.row.visual-center',
          instance,
          axis: 'y',
          anchor: 'visual-center',
          status: 'sub-pixel-jitter',
          line: 40.5,
          members: [
            { name: 'icon', coordinate: 40 },
            { name: 'label', coordinate: 41 },
          ],
        },
      ],
    });
    const captureArtifact = {
      version: 1 as const,
      captures: [semanticCapture('one', 'row-one'), semanticCapture('two', 'row-two')],
    };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toEqual([
      expect.objectContaining({
        kind: 'measurement-model-divergence',
        captureCount: 2,
        totalCaptureCount: 2,
        evidence: [
          expect.objectContaining({ captureId: 'one', scopeKey: 'row-one' }),
          expect.objectContaining({ captureId: 'two', scopeKey: 'row-two' }),
        ],
      }),
    ]);
  });

  it('uses the ledger for report diffs and compiles only promoted contracts', () => {
    const finding = {
      key: 'geometry/workspace/finding',
      kind: 'alignment-rail' as const,
      surfaceFamily: 'workspace',
      locator: locator('Shifted'),
      label: 'Shifted',
      axis: 'x' as const,
      anchor: 'inline-end' as const,
      normalizedLine: 0.5,
      offset: 4,
      captureCount: 2,
      totalCaptureCount: 2,
      evidence: [],
    };
    const ledger: GeometryLedger = {
      version: 1,
      findings: {
        [finding.key]: {
          status: 'promoted',
          baseline: { offset: 4 },
          contract: {
            name: 'workspace.trailing-actions',
            story: 'geometry--landing',
            members: [locator('First'), locator('Second'), locator('Third')],
            axis: 'x',
            anchor: 'inline-end',
            space: 'ink',
            tolerance: 0.5,
          },
        },
        'geometry/workspace/resolved': {
          status: 'accepted-debt',
          baseline: { offset: 2 },
        },
      },
    };

    expect(diffGeometryFindings({ version: 1, findings: [finding] }, ledger)).toMatchObject({
      new: [],
      changed: [],
      resolved: ['geometry/workspace/resolved'],
    });
    expect(compileGeometryContracts(ledger)).toEqual({
      version: 1,
      contracts: [
        expect.objectContaining({
          findingKey: finding.key,
          name: 'workspace.trailing-actions',
        }),
      ],
    });
  });

  it('triages unseen findings once without erasing an established baseline', () => {
    const finding = {
      key: 'geometry/workspace/finding',
      kind: 'alignment-rail' as const,
      surfaceFamily: 'workspace',
      locator: locator('Shifted'),
      label: 'Shifted',
      axis: 'x' as const,
      anchor: 'inline-end' as const,
      normalizedLine: 0.5,
      offset: 4,
      captureCount: 2,
      totalCaptureCount: 2,
      evidence: [],
    };
    const first = triageGeometryFindings(
      { version: 1, findings: [finding] },
      { version: 1, findings: {} }
    );
    const second = triageGeometryFindings(
      { version: 1, findings: [{ ...finding, offset: 7 }] },
      first
    );

    expect(second.findings[finding.key]).toEqual({
      status: 'accepted-debt',
      baseline: { offset: 4 },
      identity: {
        label: 'Shifted',
        axis: 'x',
        anchor: 'inline-end',
        surfaceFamily: 'workspace',
      },
    });
  });

  it('evaluates token equations without heuristic judgment', () => {
    const token = { value: 4, unit: 'px' as const, cssVariable: '--spacing' as const };

    expect(evaluateGeometryContractValues(undefined, [100, 100.5], 0.5)).toEqual({
      valid: true,
      maximumError: 0.5,
    });
    expect(
      evaluateGeometryContractValues(
        { kind: 'box-model-equals-token', property: 'column-gap', token: 'spacing.unit' },
        [4, 5],
        0.5,
        token
      )
    ).toEqual({ valid: false, maximumError: 1 });
    expect(
      evaluateGeometryContractValues(
        { kind: 'box-model-multiple-of-token', property: 'row-gap', token: 'spacing.unit' },
        [8, 12],
        0,
        token
      )
    ).toEqual({ valid: true, maximumError: 0 });
  });

  it('sums the declared terms that reach one token rail', () => {
    const token = { name: 'sidebar.trailingInset', value: 9, cssVariable: '--spacing-x' };
    const relation = {
      kind: 'box-model-sum-equals-token' as const,
      properties: ['padding-inline-end', 'border-inline-end-width'] as const,
      token: 'sidebar.trailingInset',
    };

    // 8px padding plus a 1px transparent border is the same 9px rail as a bare
    // 9px padding, so both belong in one contract at tolerance 0.
    expect(evaluateGeometryContractValues(relation, [9, 9, 9], 0, token)).toEqual({
      valid: true,
      maximumError: 0,
    });
    expect(evaluateGeometryContractValues(relation, [9, 8], 0, token)).toEqual({
      valid: false,
      maximumError: 1,
    });
  });

  it('refuses a sum contract that declares no properties or repeats one', () => {
    const contractLedger = (properties: readonly string[]): GeometryLedger => ({
      version: 1,
      tokens: {
        'sidebar.trailingInset': { unit: 'px', cssVariable: '--spacing-x', expected: 9 },
      },
      findings: {
        'geometry/workspace/inset': {
          status: 'promoted',
          contract: {
            name: 'workspace.sidebar.trailing-inset',
            story: 'geometry--landing',
            members: [{ role: 'text', selfFamily: 'div[text]>div[button]' }],
            axis: 'x',
            anchor: 'inline-end',
            space: 'layout-box',
            tolerance: 0,
            relation: {
              kind: 'box-model-sum-equals-token',
              properties: properties as never,
              token: 'sidebar.trailingInset',
            },
          },
        },
      },
    });

    expect(() => compileGeometryContracts(contractLedger([]))).toThrow(/sums no properties/);
    expect(() =>
      compileGeometryContracts(contractLedger(['padding-inline-end', 'padding-inline-end']))
    ).toThrow(/sums the same property twice/);
    expect(
      compileGeometryContracts(contractLedger(['padding-inline-end', 'border-inline-end-width']))
        .contracts
    ).toHaveLength(1);
  });

  it('reports an ambiguous contract member instead of measuring the first match', () => {
    const contract: GeometryContract = {
      name: 'workspace.sidebar.trailing-inset',
      story: 'geometry--landing',
      members: [{ role: 'text', selfFamily: 'div[text]>div[button],div[text]' }],
      axis: 'x',
      anchor: 'inline-end',
      space: 'layout-box',
      tolerance: 0,
      relation: {
        kind: 'box-model-sum-equals-token',
        properties: ['padding-inline-end', 'border-inline-end-width'],
        token: 'sidebar.trailingInset',
      },
    };
    const token = { name: 'sidebar.trailingInset', value: 9, cssVariable: '--spacing-x' };
    const sample = (padding: number) => ({
      description: 'div[data-slot=row]',
      value: padding + 1,
      propertyValues: { 'padding-inline-end': padding, 'border-inline-end-width': 1 },
    });

    expect(
      evaluateGeometryContractResolutions(
        contract,
        [{ label: 'text:*', matchCount: 2, samples: [sample(8), sample(3)] }],
        token
      )
    ).toEqual(['workspace.sidebar.trailing-inset: locator text:* matched 2 elements']);
    // The same two elements pass only when the contract says it means all of them.
    expect(
      evaluateGeometryContractResolutions(
        { ...contract, members: [{ ...contract.members[0]!, all: true }] },
        [{ label: 'text:*[all]', matchCount: 2, samples: [sample(8), sample(8)] }],
        token
      )
    ).toEqual([]);
  });

  it('reports the exact terms when a summed member misses the token', () => {
    const contract: GeometryContract = {
      name: 'workspace.sidebar.trailing-inset',
      story: 'geometry--landing',
      members: [
        { role: 'text', selfFamily: 'div[text]>div[button],div[text]' },
        { role: 'button', rowFamily: 'div[text]>div[button]', roleIndex: 0, all: true },
      ],
      axis: 'x',
      anchor: 'inline-end',
      space: 'layout-box',
      tolerance: 0,
      relation: {
        kind: 'box-model-sum-equals-token',
        properties: ['padding-inline-end', 'border-inline-end-width'],
        token: 'sidebar.trailingInset',
      },
    };

    expect(
      evaluateGeometryContractResolutions(
        contract,
        [
          {
            label: 'text:*',
            matchCount: 1,
            samples: [{ description: 'div[data-slot=header]', value: 9 }],
          },
          {
            label: 'button:*[all]',
            matchCount: 1,
            samples: [{ description: 'div[role=button]', value: 8 }],
          },
        ],
        { name: 'sidebar.trailingInset', value: 9, cssVariable: '--spacing-sidebar-trailing' }
      )
    ).toEqual([
      'workspace.sidebar.trailing-inset: box-model-sum-equals-token error 1px exceeds 0px (token --spacing-sidebar-trailing=9px) (text:*=9, button:*[all]=8)',
    ]);
  });

  it('records how far each icon ink centre sits from its rail median', () => {
    const witness = summarizeGeometryInkCenters('workspace.sidebar.primary-trailing-actions', [
      { label: 'button:New session', inkCenter: 254.1, containsSvg: true },
      { label: 'button:Remove project', inkCenter: 257.9, containsSvg: true },
      { label: 'button:Archive[all]', inkCenter: 257.9, containsSvg: true },
      { label: 'text:Chats', inkCenter: 100, containsSvg: false },
    ]);

    expect(witness?.medianInkCenter).toBe(257.9);
    expect(witness?.members.map((member) => member.inkCenterOffset)).toEqual([-3.8, 0, 0]);
    expect(witness?.designQuestion).toContain('button:New session');
    // Within one CSS pixel there is nothing for a designer to decide.
    expect(
      summarizeGeometryInkCenters('contract', [
        { label: 'a', inkCenter: 10, containsSvg: true },
        { label: 'b', inkCenter: 10.5, containsSvg: true },
      ])?.designQuestion
    ).toBeUndefined();
  });

  it('turns ledger decisions into discovery precision and promoted locators into coverage', () => {
    const captured = capture('one', [scope('sidebar', 'sidebar', 200, railCandidates())]);
    const metrics = computeGeometryQualityMetrics(
      { version: 1, captures: [captured] },
      {
        version: 1,
        findings: {
          'geometry/workspace/kept': {
            status: 'promoted',
            contract: {
              name: 'workspace.actions',
              story: 'geometry--landing',
              members: [locator('First'), locator('Second'), locator('Third')],
              axis: 'x',
              anchor: 'inline-end',
              space: 'ink',
              tolerance: 0.5,
            },
          },
          noise: { status: 'ignored', reason: 'content-driven edge' },
        },
      }
    );

    expect(metrics).toEqual({
      labeledFindingCount: 2,
      ignoredFindingCount: 1,
      discoveryPrecision: 0.5,
      interactivePrimitiveCount: 4,
      constrainedInteractivePrimitiveCount: 3,
      geometryCoverage: 0.75,
    });
  });
  describe('explanation-driven classification', () => {
    const contribution = (
      values: Partial<{
        padding: number;
        border: number;
        margin: number;
        gap: number;
        layout: number;
      }>
    ) => ({ padding: 0, border: 0, margin: 0, gap: 0, layout: 0, ...values });

    /**
     * A synthetic two-step chain: `wrapper` sits inside `ancestor` and the
     * measured primitive sits inside `wrapper`, so the parent-owned terms have
     * a distinct owner from the node-owned ones.
     */
    function chain(
      prefix: string,
      steps: readonly Readonly<{
        element: string;
        distance: number;
        inline: Partial<{
          padding: number;
          border: number;
          margin: number;
          gap: number;
          layout: number;
        }>;
      }>[],
      anchor: 'inline-start' | 'inline-end'
    ) {
      const nodes = steps.map((step, index) => ({
        nodeId: `${prefix}-${index}`,
        parentId: index + 1 < steps.length ? `${prefix}-${index + 1}` : 'ancestor',
        element: step.element,
        startToParent: anchor === 'inline-start' ? step.distance : 0,
        endToParent: anchor === 'inline-end' ? step.distance : 0,
        centerToParent: 0,
        inlineStart: anchor === 'inline-start' ? contribution(step.inline) : contribution({}),
        inlineEnd: anchor === 'inline-end' ? contribution(step.inline) : contribution({}),
      }));
      return [
        ...nodes,
        {
          nodeId: 'ancestor',
          element: 'div[role=tabpanel]',
          startToParent: 0,
          endToParent: 0,
          centerToParent: 0,
          inlineStart: contribution({}),
          inlineEnd: contribution({}),
        },
      ];
    }

    function explain(
      anchor: 'inline-start' | 'inline-end',
      memberSteps: Parameters<typeof chain>[1],
      referenceSteps: Parameters<typeof chain>[1],
      observedOffset: number
    ) {
      const memberNodes = chain('member', memberSteps, anchor);
      const referenceNodes = chain('reference', referenceSteps, anchor);
      const nodes = Object.fromEntries(
        [...memberNodes, ...referenceNodes].map((node) => [node.nodeId, node])
      );
      return explainGeometryOffset(
        { ...candidate('Member', 'member', 0, 0), boxModelNodeRef: 'member-0' },
        { ...candidate('Reference', 'reference', 1, 0), boxModelNodeRef: 'reference-0' },
        anchor,
        observedOffset,
        nodes
      );
    }

    it('names the padding that a css-defect must change', () => {
      const explanation = explain(
        'inline-start',
        [{ element: 'span[text]', distance: 20, inline: { padding: 20 } }],
        [{ element: 'span[text]', distance: 14, inline: { padding: 14 } }],
        6
      );

      expect(explanation?.explainedOffset).toBe(6);
      expect(explanation?.residual).toBe(0);
      expect(explanation?.repair).toEqual({
        commonAncestor: 'div[role=tabpanel]',
        edge: 'inline-start',
        terms: [
          {
            side: 'member',
            term: 'padding',
            element: 'div[role=tabpanel]',
            memberElement: 'div[role=tabpanel]',
            referenceElement: 'div[role=tabpanel]',
            memberValue: 20,
            referenceValue: 14,
            delta: 6,
          },
        ],
      });
      expect(classifyGeometryOffsetExplanation(explanation, 2)).toBe('css-defect');
    });

    it('keeps a residual larger than one device pixel structural', () => {
      const explanation = explain(
        'inline-start',
        [{ element: 'span[text]', distance: 20, inline: { padding: 20 } }],
        [{ element: 'span[text]', distance: 14, inline: { padding: 14 } }],
        6.8
      );

      expect(explanation?.residual).toBeCloseTo(0.8, 5);
      expect(classifyGeometryOffsetExplanation(explanation, 2)).toBe('structural');
      // The same measurement on a 1× capture is inside one device pixel.
      expect(classifyGeometryOffsetExplanation(explanation, 1)).toBe('css-defect');
    });

    it('keeps a layout-dominated difference structural even with a zero residual', () => {
      const explanation = explain(
        'inline-start',
        [{ element: 'span[text]', distance: 26, inline: { padding: 20, layout: 6 } }],
        [{ element: 'span[text]', distance: 14, inline: { padding: 14 } }],
        12
      );

      expect(explanation?.residual).toBe(0);
      expect(classifyGeometryOffsetExplanation(explanation, 2)).toBe('structural');
    });

    it('folds a box-model-clean offset inside 1.5px into an optical residual', () => {
      const explanation = explain(
        'inline-start',
        [{ element: 'svg[img]', distance: 9, inline: { padding: 8, border: 1 } }],
        [{ element: 'svg[img]', distance: 9, inline: { padding: 8, border: 1 } }],
        -1
      );

      expect(explanation?.explainedOffset).toBe(0);
      expect(explanation?.repair).toBeUndefined();
      expect(classifyGeometryOffsetExplanation(explanation, 2)).toBe('optical-residual');
    });

    it('never proposes a repair from a centre coordinate', () => {
      const memberNodes = chain(
        'member',
        [{ element: 'span[text]', distance: 20, inline: { padding: 20 } }],
        'inline-start'
      );
      const referenceNodes = chain(
        'reference',
        [{ element: 'span[text]', distance: 14, inline: { padding: 14 } }],
        'inline-start'
      );
      const explanation = explainGeometryOffset(
        { ...candidate('Member', 'member', 0, 0), boxModelNodeRef: 'member-0' },
        { ...candidate('Reference', 'reference', 1, 0), boxModelNodeRef: 'reference-0' },
        'inline-center',
        -3.5,
        Object.fromEntries([...memberNodes, ...referenceNodes].map((node) => [node.nodeId, node]))
      );

      expect(explanation?.repair).toBeUndefined();
      expect(classifyGeometryOffsetExplanation(explanation, 2)).toBe('structural');
    });

    it('reports an unexplainable offset as structural', () => {
      expect(classifyGeometryOffsetExplanation(undefined, 2)).toBe('structural');
    });
  });

  it('labels every finding without printing a raw row family', () => {
    expect(
      geometryFindingLabel({ role: 'tab', name: 'Files Close Files' }, 'Files', {
        naming: { nestedControlNames: ['Close Files'] },
      })
    ).toBe('Files');
    expect(geometryFindingLabel({ role: 'tab', name: 'Files' }, 'Files')).toBe('Files');
    expect(
      geometryFindingLabel(
        { role: 'button', rowFamily: 'div[text]>div[button]', roleIndex: 0 },
        'Audit Sidebar semantic baselines',
        {
          repeatedRow: true,
          naming: {
            nestedControlNames: ['More actions', 'Archive session'],
            rowTitle: 'Audit Sidebar semantic baselines',
          },
        }
      )
    ).toBe('button “Audit Sidebar semantic baselines”');
    expect(
      geometryFindingLabel(
        { role: 'button', rowFamily: 'div[text]>div[button],div[text]', roleIndex: 1 },
        'svg'
      )
    ).toBe('button #1 in row');
    expect(
      geometryFindingLabel(
        { role: 'text', rowFamily: 'div[tablist]>div[tab],div[tab]', roleIndex: 0 },
        '38m'
      )
    ).toBe('text “38m” in tab bar');
    expect(geometryFindingLabel(undefined, 'sidebar.row.visual-center')).toBe(
      'sidebar.row.visual-center'
    );
  });

  it('reads a named token from CSS and refuses a value the document does not define', () => {
    const token = { unit: 'px' as const, cssVariable: '--spacing-sidebar-trailing' as const };

    expect(resolveGeometryDesignToken('sidebar.trailingInset', token, ' 9px ')).toEqual({
      name: 'sidebar.trailingInset',
      cssVariable: '--spacing-sidebar-trailing',
      value: 9,
    });
    expect(() => resolveGeometryDesignToken('sidebar.trailingInset', token, '')).toThrow(
      /resolved to nothing/
    );
    expect(() => resolveGeometryDesignToken('sidebar.trailingInset', token, '0.5rem')).toThrow(
      /not a px length/
    );
    expect(() => resolveGeometryDesignToken('sidebar.trailingInset', undefined, '9px')).toThrow(
      /not declared in the ledger/
    );
  });

  it('identifies every element structurally, never by its accessible name', () => {
    const aggregated = new Set([
      geometryRowFamilyKey(undefined, 'div[text]>div[button]', 'button', 0),
    ]);
    const sessionRow = {
      role: 'button',
      name: 'More actions Audit Sidebar semantic baselines 38m Archive session',
      rowFamily: 'div[text]>div[button]',
      familyIndex: 3,
      roleIndex: 0,
    } as const;

    // A data-driven family aggregates: the third rendered row of a chat list is
    // the same reviewable element as the first, so the instance index goes.
    expect(geometryIdentityLocator(sessionRow, { aggregatedRowFamilies: aggregated })).toEqual({
      role: 'button',
      rowFamily: 'div[text]>div[button]',
      roleIndex: 0,
    });

    // Settings, Help and Archive share a DOM shape and a section, and are three
    // different controls. Nothing but the instance index can separate them once
    // the name is a label, so the index is what identity uses.
    const footerButton = (familyIndex: number, name: string) =>
      ({
        role: 'button',
        name,
        rowFamily: 'div[text]>button[button]',
        familyIndex,
        roleIndex: 0,
        section: 'sidebar.footer',
      }) as const;
    const identities = [
      footerButton(0, 'Settings'),
      footerButton(1, 'Help'),
      footerButton(2, 'Archive'),
    ].map((footer) => geometryIdentityLocator(footer, { aggregatedRowFamilies: aggregated }));
    expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(3);
    expect(identities.every((identity) => !('name' in identity))).toBe(true);

    // The same control in another locale is the same control.
    expect(
      geometryIdentityLocator(footerButton(0, '设置'), { aggregatedRowFamilies: aggregated })
    ).toEqual(geometryIdentityLocator(footerButton(0, 'Settings'), {}));
  });

  it('merges one repeated row across locales instead of splitting it by name', () => {
    const sessionRow = (
      title: string,
      actions: readonly [string, string],
      suffix: string,
      row: number,
      coordinate: number
    ): GeometryCapturedCandidate => ({
      elementId: `row:${title}`,
      primitiveId: `${title}-${suffix}`,
      locator: {
        role: 'button',
        name: `${actions[0]} ${title} ${actions[1]}`,
        landmark: { role: 'complementary', name: 'Workspace' },
        rowFamily: 'div[text]>div[button]',
        roleIndex: 0,
      },
      label: title,
      naming: { nestedControlNames: [...actions], rowTitle: title },
      rowId: `session-row-${row}`,
      kind: 'text',
      space: 'ink',
      anchor: 'inline-end',
      coordinate,
      yStart: row * 32,
      yEnd: row * 32 + 16,
    });
    const rows = (actions: readonly [string, string], suffix: string) => [
      sessionRow('Alpha', actions, suffix, 0, 100),
      sessionRow('Beta', actions, suffix, 1, 100),
      sessionRow('Gamma', actions, suffix, 2, 100),
      sessionRow('Delta', actions, suffix, 3, 104),
    ];
    const english = {
      ...capture('english', [
        scope('sidebar', 'sidebar', 200, rows(['More actions', 'Archive session'], 'en')),
      ]),
      dimensions: { theme: 'light', locale: 'en', density: 'default' },
    };
    const chinese = {
      ...capture('chinese', [
        scope('sidebar', 'sidebar', 200, rows(['更多操作', '归档会话'], 'zh')),
      ]),
      dimensions: { theme: 'light', locale: 'zh_CN', density: 'default' },
    };
    const captureArtifact = { version: 1 as const, captures: [english, chinese] };

    expect(collectRepeatedGeometryRowFamilies(captureArtifact).get('workspace')).toContain(
      'div[text]>div[button]'
    );
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toHaveLength(1);
    const [finding] = findings.findings;
    expect(finding?.locator).toEqual({
      role: 'button',
      landmark: { role: 'complementary', name: 'Workspace' },
      rowFamily: 'div[text]>div[button]',
      roleIndex: 0,
    });
    expect(finding?.label).toBe('button “Delta”');
    expect(finding?.evidence.map((item) => item.captureId)).toEqual(['chinese', 'english']);
    expect(finding?.dimensionSensitivity).toBeUndefined();
  });

  describe('marker-free Y discovery', () => {
    const blockCandidate = (
      primitiveId: string,
      row: number,
      coordinate: number,
      overrides: Partial<GeometryCapturedBlockCandidate> = {}
    ): GeometryCapturedBlockCandidate => ({
      elementId: `${primitiveId}:label`,
      primitiveId,
      locator: {
        role: 'button',
        name: `More actions Row ${row} Archive`,
        landmark: { role: 'complementary', name: 'Workspace' },
        rowFamily: 'div[text]>div[button]',
        roleIndex: 0,
      },
      label: `Row ${row}`,
      naming: { nestedControlNames: ['More actions', 'Archive'], rowTitle: `Row ${row}` },
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
    const iconOverrides = (row: number) => ({
      kind: 'svg',
      xStart: 20,
      xEnd: 32,
      label: 'icon',
      locator: {
        role: 'button',
        name: `More actions Row ${row} Archive`,
        landmark: { role: 'complementary' as const, name: 'Workspace' },
        rowFamily: 'div[text]>div[button]',
        roleIndex: 1,
      },
    });
    const rowsOf = (rows: readonly number[], iconOffset: number) =>
      rows.flatMap((row) => [
        blockCandidate(`title-${row}`, row, row * 32),
        blockCandidate(`time-${row}`, row, row * 32, { xStart: 240, xEnd: 262 }),
        blockCandidate(`icon-${row}`, row, row * 32 + iconOffset, iconOverrides(row)),
      ]);
    const blockCapture = (captureId: string, iconOffset: number): GeometryCapture => ({
      ...capture(captureId, [
        {
          key: 'sidebar',
          identity: 'sidebar',
          source: 'hint',
          depth: 2,
          rect: { x: 0, y: 0, width: 280, height: 400 },
          candidates: [],
          blockCandidates: rowsOf([1, 2, 3], iconOffset),
        },
      ]),
      viewport: { width: 1440, height: 900 },
    });

    it('aggregates one Y finding over every row of a family it repeats in', () => {
      const captureArtifact = { version: 1 as const, captures: [blockCapture('one', 2)] };
      const observation = observeGeometryCaptures(captureArtifact);

      expect(observation.captures[0]?.blockRails).toHaveLength(3);
      const findings = createGeometryFindings(captureArtifact, observation);
      expect(findings.findings).toEqual([
        expect.objectContaining({
          kind: 'alignment-rail',
          axis: 'y',
          anchor: 'visual-center',
          label: 'button \u201cRow 1\u201d',
          offset: 2,
          // Three rows, one finding: the identity is the slot, not the row.
          captureCount: 1,
        }),
      ]);
      expect(findings.findings[0]?.locator).toEqual({
        role: 'button',
        landmark: { role: 'complementary', name: 'Workspace' },
        rowFamily: 'div[text]>div[button]',
        roleIndex: 1,
      });
      expect(findings.findings[0]?.evidence[0]?.rowId).toBe('visual-row:1');
    });

    it('merges Y evidence across captures without duplicating a row', () => {
      const captureArtifact = {
        version: 1 as const,
        captures: [blockCapture('one', 2), blockCapture('two', 2)],
      };
      const findings = createGeometryFindings(
        captureArtifact,
        observeGeometryCaptures(captureArtifact)
      );

      expect(findings.findings).toHaveLength(1);
      expect(findings.findings[0]?.evidence.map((item) => item.captureId)).toEqual(['one', 'two']);
    });

    it('separates two lists of one DOM family by the scope they render in', () => {
      const sectioned = (section: string, row: number) =>
        rowsOf([row], 2).map((member) => ({ ...member, sectionScope: section }));
      const captureArtifact = {
        version: 1 as const,
        captures: [
          {
            ...blockCapture('one', 2),
            scopes: [
              {
                key: 'sidebar',
                identity: 'sidebar',
                source: 'hint' as const,
                depth: 2,
                rect: { x: 0, y: 0, width: 280, height: 400 },
                candidates: [],
                blockCandidates: [
                  ...sectioned('sidebar.tasks', 1),
                  ...sectioned('sidebar.chats', 2),
                ],
              },
            ],
          },
        ],
      };
      const findings = createGeometryFindings(
        captureArtifact,
        observeGeometryCaptures(captureArtifact)
      );

      expect(findings.findings).toHaveLength(2);
      expect(findings.findings.map((finding) => finding.locator?.section).sort()).toEqual([
        'sidebar.chats',
        'sidebar.tasks',
      ]);
    });

    it('names the font metric instead of leaving it in the residual', () => {
      const step = (nodeId: string, parentId: string | undefined, top: number) => ({
        nodeId,
        element: nodeId,
        ...(parentId ? { parentId } : {}),
        startToParent: 0,
        endToParent: 0,
        centerToParent: 0,
        inlineStart: { padding: 0, border: 0, margin: 0, gap: 0, layout: 0 },
        inlineEnd: { padding: 0, border: 0, margin: 0, gap: 0, layout: 0 },
        blockStartToParent: top,
        blockEndToParent: 0,
        blockCenterToParent: 0,
        blockStart: { padding: 0, border: 0, margin: 0, gap: 0, layout: top },
        blockEnd: { padding: 0, border: 0, margin: 0, gap: 0, layout: 0 },
      });
      const nodes = {
        icon: step('icon', 'row', 0),
        text: step('text', 'row', 0),
        row: step('row', undefined, 0),
      };
      const explanation = explainGeometryOffset(
        { ...blockCandidate('icon-1', 1, 34, iconOverrides(1)), boxModelNodeRef: 'icon' },
        {
          ...blockCandidate('title-1', 1, 32, { typographyOffset: -0.5 }),
          boxModelNodeRef: 'text',
        },
        'visual-center',
        2,
        nodes
      );

      expect(explanation?.referencePath.contribution.typography).toBe(-0.5);
      expect(explanation?.memberPath.contribution.typography).toBeUndefined();
      expect(explanation?.explainedOffset).toBe(0.5);
      expect(explanation?.residual).toBe(1.5);
      // A centre carries no declared edge term, so nothing is proposed as a fix.
      expect(explanation?.repair).toBeUndefined();
    });

    it('compares a marker rule and Y discovery by element, listing what only one saw', () => {
      const captureArtifact = blockCapture('one', 2);
      const withMarkers: GeometryCapture = {
        ...captureArtifact,
        semanticAlignments: [
          {
            group: 'sidebar.row.visual-center',
            instance: 'row-1',
            axis: 'y',
            anchor: 'visual-center',
            status: 'violation',
            line: 32,
            members: [
              { name: 'session-title-ink', coordinate: 32, primitiveId: 'title-1' },
              { name: 'leading-indicator-ink', coordinate: 34, primitiveId: 'icon-1' },
              { name: 'unread-dot', coordinate: 33, primitiveId: 'dot-1' },
            ],
          },
        ],
      };
      const rails =
        observeGeometryCaptures({ version: 1, captures: [withMarkers] }).captures[0]?.blockRails ??
        [];
      const parity = compareMarkerAlignmentsToBlockRails(withMarkers, rails, {
        group: 'sidebar.row.visual-center',
      });

      expect(parity.maxCoordinateDelta).toBe(0);
      expect(parity.matchedMemberCount).toBe(2);
      expect(parity.rows[0]?.markerOnly).toEqual(['unread-dot']);
      expect(parity.rows[0]?.discoveryOnly).toEqual(['Row 1']);
      expect(parity.rows[0]?.members).toEqual([
        expect.objectContaining({ name: 'session-title-ink', offsetDelta: 0 }),
        expect.objectContaining({ name: 'leading-indicator-ink', offsetDelta: 0 }),
      ]);
    });
  });

  it('keeps a name that carries data out of the finding identity', () => {
    const projectRow = {
      role: 'button',
      name: 'lody \u00b7 Geometry Mac \u00b7 /workspace/lody',
      landmark: { role: 'complementary', name: 'Workspace' },
      rowFamily: 'div[button]>button[button],span[text],div[text]',
      roleIndex: 0,
    } as const;

    expect(isGeometryDataBearingName('lody \u00b7 Geometry Mac \u00b7 /workspace/lody')).toBe(true);
    expect(isGeometryDataBearingName('38m')).toBe(true);
    expect(isGeometryDataBearingName('2026-09-02')).toBe(true);
    expect(isGeometryDataBearingName('Remove project')).toBe(false);
    expect(isGeometryDataBearingName('Files Close Files')).toBe(false);
    // The name is dropped from identity and the section takes its place, but the
    // card still prints the row title a designer recognises.
    expect(geometryIdentityLocator(projectRow, { section: 'sidebar.local-projects' })).toEqual({
      role: 'button',
      landmark: { role: 'complementary', name: 'Workspace' },
      rowFamily: 'div[button]>button[button],span[text],div[text]',
      roleIndex: 0,
      section: 'sidebar.local-projects',
    });
    expect(
      geometryFindingLabel(projectRow, 'lody', {
        naming: { rowTitle: 'lody' },
        repeatedRow: true,
      })
    ).toBe('button \u201clody\u201d');
    // Renaming a control cannot move its key, because no name is in one.
    const removeProject = (name: string) =>
      alignmentFindingKey({
        surfaceFamily: 'workspace',
        locator: geometryIdentityLocator(
          { role: 'button', name, rowFamily: 'div[text]>button[button]', familyIndex: 1 },
          { section: 'sidebar.local-projects' }
        ),
        anchor: 'inline-end',
        axis: 'x',
      });
    expect(removeProject('Remove project')).toBe(removeProject('\u79fb\u9664\u9879\u76ee'));
  });

  it('marks a finding seen in only one value of a varying capture axis', () => {
    const light = {
      ...capture('light', [scope('sidebar', 'sidebar', 200, railCandidates('-a'))]),
      dimensions: { theme: 'light', locale: 'en', density: 'default' },
    };
    const dark = {
      ...capture('dark', [
        scope('sidebar', 'sidebar', 200, [
          candidate('First', 'one-b', 0, 100),
          candidate('Second', 'two-b', 1, 100),
          candidate('Third', 'three-b', 2, 100),
          candidate('Shifted', 'shifted-b', 3, 100),
        ]),
      ]),
      dimensions: { theme: 'dark', locale: 'en', density: 'default' },
    };
    const captureArtifact = { version: 1 as const, captures: [light, dark] };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toEqual([
      expect.objectContaining({
        label: 'Shifted',
        dimensionSensitivity: [{ axis: 'theme', value: 'light' }],
      }),
    ]);
  });
});

describe('one Y finding per element', () => {
  const rowCandidate = (
    primitiveId: string,
    anchor: GeometryCapturedBlockCandidate['anchor'],
    coordinate: number,
    overrides: Partial<GeometryCapturedBlockCandidate> = {}
  ): GeometryCapturedBlockCandidate => ({
    elementId: `${primitiveId}:${anchor}`,
    primitiveId,
    locator: {
      role: 'text',
      rowFamily: 'div[text]>span[text],svg[img]',
      familyIndex: 0,
      roleIndex: 0,
    },
    label: primitiveId,
    rowId: 'visual-row:1',
    rowFamily: 'div[text]>span[text],svg[img]',
    kind: 'text',
    space: 'ink',
    anchor,
    coordinate,
    xStart: 20,
    xEnd: 120,
    yStart: coordinate - 8,
    yEnd: coordinate + 8,
    ...overrides,
  });
  const captureOf = (candidates: readonly GeometryCapturedBlockCandidate[]): GeometryCapture => ({
    captureId: 'one',
    surfaceFamily: 'workspace',
    surface: 'Workspace',
    storyId: 'story',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: '',
    scopes: [
      {
        key: 'sidebar',
        identity: 'sidebar',
        source: 'hint',
        depth: 2,
        rect: { x: 0, y: 0, width: 280, height: 400 },
        candidates: [],
        blockCandidates: candidates,
      },
    ],
  });

  it('picks the verdict anchor from what the row is made of', () => {
    const rail = (anchor: GeometryCapturedBlockCandidate['anchor'], kinds: readonly string[]) => ({
      rowId: 'row',
      anchor,
      line: 0,
      spread: 0,
      support: kinds.length,
      sampleSize: kinds.length,
      horizontalSpan: 100,
      members: kinds.map((kind, index) => ({
        elementId: `${anchor}-${index}`,
        rowId: 'row',
        kind,
        anchor,
        coordinate: 0,
        xStart: 0,
        xEnd: 10,
        yStart: 0,
        yEnd: 10,
        delta: 0,
        outlier: false,
      })),
      outliers: [],
    });

    expect(
      selectGeometryVerdictAnchor([
        rail('block-center', ['text', 'svg']),
        rail('visual-center', ['text', 'svg']),
      ])
    ).toMatchObject({ reason: 'mixed-kinds', rail: { anchor: 'visual-center' } });
    // A painted CSS shape is a mark like an icon, so the row is still mixed.
    expect(
      selectGeometryVerdictAnchor([
        rail('block-center', ['text', 'shape']),
        rail('visual-center', ['text', 'shape']),
      ])
    ).toMatchObject({ reason: 'mixed-kinds', rail: { anchor: 'visual-center' } });
    expect(
      selectGeometryVerdictAnchor([
        rail('block-center', ['text', 'text']),
        rail('text-baseline', ['text', 'text']),
      ])
    ).toMatchObject({ reason: 'all-text', rail: { anchor: 'text-baseline' } });
    expect(
      selectGeometryVerdictAnchor([
        rail('block-center', ['field', 'button']),
        rail('block-start', ['field', 'button']),
      ])
    ).toMatchObject({ reason: 'boxes-only', rail: { anchor: 'block-center' } });
  });

  it('reports one finding with the other anchors as supporting measurements', () => {
    // Three text runs and an icon on one row: the icon sits 2px low at every
    // anchor the row measured it on. That is ONE thing wrong, not four.
    const anchors = ['block-start', 'block-center', 'block-end', 'visual-center'] as const;
    const candidates = anchors.flatMap((anchor) => [
      rowCandidate('title', anchor, 40),
      rowCandidate('time', anchor, 40, { xStart: 200, xEnd: 240 }),
      rowCandidate('icon', anchor, 42, {
        kind: 'svg',
        xStart: 4,
        xEnd: 16,
        locator: {
          role: 'img',
          rowFamily: 'div[text]>span[text],svg[img]',
          familyIndex: 0,
          roleIndex: 0,
        },
      }),
    ]);
    const artifact = { version: 1 as const, captures: [captureOf(candidates)] };
    const findings = createGeometryFindings(artifact, observeGeometryCaptures(artifact));

    expect(findings.findings).toHaveLength(1);
    const [finding] = findings.findings;
    expect(finding?.anchor).toBe('visual-center');
    expect(finding?.verdictAnchorReason).toBe('mixed-kinds');
    expect(finding?.offset).toBe(2);
    // `block-center` is the only supporting anchor here: a block EDGE rail
    // takes one kind, and an icon top beside a line-box top claims nothing.
    expect(
      finding?.evidence[0]?.supportingAnchors?.map((measurement) => measurement.anchor).sort()
    ).toEqual(['block-center']);
    // Every member of the row travels with the finding, so a card can annotate
    // the row without measuring anything a second time.
    expect(finding?.evidence[0]?.rowMembers?.map((member) => member.primitiveId).sort()).toEqual([
      'icon',
      'time',
      'title',
    ]);
  });

  it('reports a two-member row as one spread instead of two blamed outliers', () => {
    const candidates = (['block-center', 'text-baseline'] as const).flatMap((anchor) => [
      rowCandidate('avatar-initial', anchor, 40, { label: 'G' }),
      rowCandidate('workspace-title', anchor, 43, {
        label: 'Geometry Lab',
        xStart: 40,
        xEnd: 200,
      }),
    ]);
    const artifact = { version: 1 as const, captures: [captureOf(candidates)] };
    const findings = createGeometryFindings(artifact, observeGeometryCaptures(artifact));

    expect(findings.findings).toHaveLength(1);
    const [finding] = findings.findings;
    expect(finding?.kind).toBe('row-spread');
    expect(finding?.anchor).toBe('text-baseline');
    expect(finding?.spread).toBe(3);
    // The spread, not half of it, and no direction attributed to either member.
    expect(finding?.offset).toBe(3);
    expect(finding?.label).toContain('G');
    expect(finding?.label).toContain('Geometry Lab');
    expect(finding?.evidence[0]?.rowMembers).toHaveLength(2);
  });
});

describe('when a row family lists and when it enumerates', () => {
  const rowCandidateOf = (
    section: string,
    rowFamily: string,
    familyIndex: number,
    name?: string
  ): GeometryCapturedCandidate => ({
    elementId: `${section}-${familyIndex}`,
    primitiveId: `${section}-${familyIndex}`,
    locator: { role: 'button', ...(name ? { name } : {}), rowFamily, familyIndex, roleIndex: 0 },
    label: name ?? 'row',
    sectionScope: section,
    rowId: `row-${familyIndex}`,
    rowFamily,
    kind: 'text',
    space: 'ink',
    anchor: 'inline-start',
    coordinate: 0,
    yStart: 0,
    yEnd: 16,
  });
  const captureOf = (candidates: readonly GeometryCapturedCandidate[]): GeometryCapture => ({
    captureId: 'one',
    surfaceFamily: 'workspace',
    surface: 'Workspace',
    storyId: 'story',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: '',
    scopes: [
      {
        key: 'sidebar',
        identity: 'sidebar',
        source: 'hint',
        depth: 2,
        rect: { x: 0, y: 0, width: 280, height: 400 },
        candidates: [...candidates],
      },
    ],
  });

  it('aggregates a list and keeps a short enumeration apart', () => {
    const footer = ['Settings', 'Help', 'Archive'].map((name, index) =>
      rowCandidateOf('sidebar.footer', 'div[text]>button[button]', index, name)
    );
    const chats = [0, 1, 2].map((index) =>
      rowCandidateOf('sidebar.chats', 'div[text]>div[button]', index, 'More actions')
    );
    const aggregated =
      collectAggregatedGeometryRowFamilies({
        version: 1,
        captures: [captureOf([...footer, ...chats])],
      }).get('workspace') ?? new Set<string>();

    // Three chat rows carry one `More actions`: one control, seen three times.
    expect(
      aggregated.has(geometryRowFamilyKey('sidebar.chats', 'div[text]>div[button]', 'button', 0))
    ).toBe(true);
    // Settings, Help and Archive share a DOM shape and nothing else.
    expect(
      aggregated.has(
        geometryRowFamilyKey('sidebar.footer', 'div[text]>button[button]', 'button', 0)
      )
    ).toBe(false);
  });

  it('aggregates a two-row list whose rows name themselves from data', () => {
    const projects = [0, 1].map((index) =>
      rowCandidateOf(
        'sidebar.projects',
        'div[text]>button[button]',
        index,
        `lody · Geometry Mac · /workspace/lody-${index}`
      )
    );
    const aggregated =
      collectAggregatedGeometryRowFamilies({
        version: 1,
        captures: [captureOf(projects)],
      }).get('workspace') ?? new Set<string>();

    expect(
      aggregated.has(
        geometryRowFamilyKey('sidebar.projects', 'div[text]>button[button]', 'button', 0)
      )
    ).toBe(true);
  });
});

describe('re-keying a reviewed finding', () => {
  const finding = (key: string, label: string, offset: number): GeometryFinding => ({
    key,
    kind: 'alignment-rail',
    surfaceFamily: 'workspace',
    label,
    axis: 'y',
    anchor: 'visual-center',
    offset,
    captureCount: 1,
    totalCaptureCount: 1,
    evidence: [],
  });
  const ledger = (): GeometryLedger => ({
    version: 1,
    findings: {
      'geometry/workspace/old-machine': {
        status: 'accepted-debt',
        reason: 'Reviewed: optical centring of the machine icon.',
        baseline: { offset: -4 },
        identity: {
          label: 'Machine',
          axis: 'y',
          anchor: 'visual-center',
          surfaceFamily: 'workspace',
        },
      },
      'geometry/workspace/old-zh-machine': {
        status: 'accepted-debt',
        baseline: { offset: -4 },
        identity: {
          label: '机器',
          axis: 'y',
          anchor: 'visual-center',
          surfaceFamily: 'workspace',
        },
      },
      'geometry/workspace/old-unreviewed': {
        status: 'accepted-debt',
        baseline: { offset: 9 },
      },
    },
  });

  it('pairs a resolved key with the new key of the same element', () => {
    const artifact = {
      version: 1 as const,
      findings: [finding('geometry/workspace/new-machine', 'Machine', -4)],
    };
    const diff = diffGeometryFindings(artifact, ledger());

    expect(diff.rekeyed).toEqual([
      {
        from: 'geometry/workspace/old-machine',
        to: 'geometry/workspace/new-machine',
        reason: 'label',
        label: 'Machine',
      },
    ]);
    // A locale-renamed twin cannot be matched by label, so the measurement rule
    // takes it — but only once, because the label match already claimed it.
    expect(diff.rekeyed).toHaveLength(1);
    expect(diff.new).toEqual([]);
    // An entry with no reviewed identity stays honestly resolved.
    expect(diff.resolved).toEqual([
      'geometry/workspace/old-unreviewed',
      'geometry/workspace/old-zh-machine',
    ]);
  });

  it('matches a locale-renamed finding by axis, anchor, surface and magnitude', () => {
    const withoutLabelMatch: GeometryLedger = {
      version: 1,
      findings: {
        'geometry/workspace/old-zh-machine':
          ledger().findings['geometry/workspace/old-zh-machine']!,
      },
    };
    const artifact = {
      version: 1 as const,
      findings: [finding('geometry/workspace/new-machine', 'Machine', -4.1)],
    };
    const pairs = matchRekeyedGeometryFindings(
      ['geometry/workspace/old-zh-machine'],
      artifact.findings,
      withoutLabelMatch
    );

    expect(pairs).toEqual([
      {
        from: 'geometry/workspace/old-zh-machine',
        to: 'geometry/workspace/new-machine',
        reason: 'measurement',
        label: '机器',
      },
    ]);
    // A quarter pixel is the whole tolerance: anything further apart is a
    // different measurement, not the same element under a new key.
    expect(
      matchRekeyedGeometryFindings(
        ['geometry/workspace/old-zh-machine'],
        [finding('geometry/workspace/new-machine', 'Machine', -4.6)],
        withoutLabelMatch
      )
    ).toEqual([]);
  });

  it('migrates the review to the new key instead of re-opening it', () => {
    const artifact = {
      version: 1 as const,
      findings: [finding('geometry/workspace/new-machine', 'Machine', -4)],
    };
    const migrated = triageGeometryFindings(artifact, ledger());

    expect(migrated.findings['geometry/workspace/old-machine']).toBeUndefined();
    expect(migrated.findings['geometry/workspace/new-machine']).toEqual({
      status: 'accepted-debt',
      reason: 'Reviewed: optical centring of the machine icon.',
      // The baseline travels: a structural re-key must not silently accept the
      // current offset as the reviewed one.
      baseline: { offset: -4 },
      identity: {
        label: 'Machine',
        axis: 'y',
        anchor: 'visual-center',
        surfaceFamily: 'workspace',
      },
    });
  });
});

describe('marker removal readiness', () => {
  it('holds a rule back until discovery reproduces every member on every capture', () => {
    const member = (
      primitiveId: string,
      coordinate: number,
      overrides: Partial<GeometryCapturedBlockCandidate> = {}
    ): GeometryCapturedBlockCandidate => ({
      elementId: primitiveId,
      primitiveId,
      locator: { role: 'text', rowFamily: 'div[text]>span[text]', roleIndex: 0 },
      label: primitiveId,
      rowId: 'visual-row:1',
      kind: 'text',
      space: 'ink',
      anchor: 'visual-center',
      coordinate,
      xStart: 0,
      xEnd: 40,
      yStart: coordinate - 8,
      yEnd: coordinate + 8,
      ...overrides,
    });
    const built = (extra: readonly GeometryCapturedBlockCandidate[]): GeometryCapture => ({
      captureId: 'one',
      surfaceFamily: 'workspace',
      surface: 'Workspace',
      storyId: 'story',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      screenshot: '',
      scopes: [
        {
          key: 'sidebar',
          identity: 'sidebar',
          source: 'hint',
          depth: 2,
          rect: { x: 0, y: 0, width: 280, height: 400 },
          candidates: [],
          blockCandidates: [
            member('title', 32),
            member('time', 32, { xStart: 200, xEnd: 240 }),
            ...extra,
          ],
        },
      ],
      semanticAlignments: [
        {
          group: 'sidebar.row.visual-center',
          instance: 'row-1',
          axis: 'y',
          anchor: 'visual-center',
          status: 'violation',
          line: 32,
          members: [
            { name: 'session-title-ink', coordinate: 32, primitiveId: 'title' },
            { name: 'leading-indicator-ink', coordinate: 34, primitiveId: 'dot' },
          ],
        },
      ],
    });

    const invisibleDot = { version: 1 as const, captures: [built([])] };
    const notReady = assessGeometryMarkerRemoval(
      invisibleDot,
      observeGeometryCaptures(invisibleDot)
    );
    expect(notReady.readyRules).toEqual([]);
    expect(notReady.rules[0]?.members).toContainEqual(
      expect.objectContaining({ name: 'leading-indicator-ink', reason: 'not-observed' })
    );

    // Once the painted dot is a discovered primitive, the rule is removable.
    const paintedDot = {
      version: 1 as const,
      captures: [built([member('dot', 34, { kind: 'shape', xStart: 0, xEnd: 8 })])],
    };
    const ready = assessGeometryMarkerRemoval(paintedDot, observeGeometryCaptures(paintedDot));
    expect(ready.readyRules).toEqual(['sidebar.row.visual-center']);
    expect(ready.rules[0]?.matchedMemberCount).toBe(ready.rules[0]?.memberCount);
  });
});
