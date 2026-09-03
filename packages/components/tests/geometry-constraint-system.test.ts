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
  checkGeometryLedgerRatchet,
  formatGeometryRatchetViolations,
  formatGeometryRepairProposal,
  geometryFindingDevicePixel,
  geometryFindingKeysInRepairGroup,
  geometryRepairCssProperty,
  geometryRepairGroupKey,
  verifyGeometryFixes,
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
  type GeometryBoxModelPathStep,
  type GeometryCaptureArtifact,
  type GeometryFinding,
  type GeometryFindingArtifact,
  type GeometryLedger,
  type GeometryRepairProposal,
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

  it('carries the repair group onto the finding without touching its key', () => {
    // Two rails whose outlier is off by the same declared padding, on the same
    // component: one ticket, two reviewed findings.
    const contribution = (padding: number) => ({
      padding,
      border: 0,
      margin: 0,
      gap: 0,
      layout: 0,
    });
    const node = (
      nodeId: string,
      padding: number,
      parentId?: string
    ): GeometryBoxModelPathStep => ({
      nodeId,
      element: 'div[role=button]',
      className: 'pe-3',
      component: 'SidebarRowShared',
      ...(parentId ? { parentId } : {}),
      startToParent: 0,
      endToParent: padding,
      centerToParent: 0,
      inlineStart: contribution(0),
      inlineEnd: contribution(padding),
    });
    const measuredRail = (suffix: string) =>
      railCandidates(suffix).map((item) => ({ ...item, boxModelNodeRef: item.primitiveId }));
    // The outlier's own trailing padding is 4px short of its row's, which is
    // exactly the offset the rail measured.
    const boxModelNodes = Object.fromEntries(
      ['a', 'b'].flatMap((suffix) => [
        ...['one', 'two', 'three'].map(
          (name) => [`${name}-${suffix}`, node(`${name}-${suffix}`, 14, 'root')] as const
        ),
        [`shifted-${suffix}`, node(`shifted-${suffix}`, 10, 'root')] as const,
        ['root', { ...node('root', 0), element: 'aside[complementary]' }] as const,
      ])
    );
    const captureArtifact = {
      version: 1 as const,
      captures: [
        {
          ...capture('one', [scope('sidebar-one', 'sidebar', 200, measuredRail('-a'))]),
          boxModelNodes,
        },
        {
          ...capture('two', [scope('sidebar-two', 'sidebar', 240, measuredRail('-b'))]),
          boxModelNodes,
        },
      ],
    };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    const finding = findings.findings[0];
    expect(finding?.classification).toBe('css-defect');
    expect(finding?.repairGroup).toBe(finding?.repairProposal?.repairGroup);
    expect(finding?.repairGroup).toBe(geometryRepairGroupKey(finding!.repairProposal!));
    // Grouping is evidence, so the key is exactly what it was without it.
    expect(finding?.key).toBe(
      alignmentFindingKey({
        surfaceFamily: 'workspace',
        locator: geometryIdentityLocator(finding!.locator!),
        anchor: 'inline-end',
      })
    );
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
        // Grouping evidence: the ticket this offset belongs to, never identity.
        repairGroup: expect.stringMatching(/^geometry\/repair\//),
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
          status: 'debt',
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
      status: 'debt',
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
        repairGroup: expect.stringMatching(/^geometry\/repair\//),
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
        status: 'debt',
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
        status: 'debt',
        baseline: { offset: -4 },
        identity: {
          label: '机器',
          axis: 'y',
          anchor: 'visual-center',
          surfaceFamily: 'workspace',
        },
      },
      'geometry/workspace/old-unreviewed': {
        status: 'debt',
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
      status: 'debt',
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

describe('a cross-family rail has to survive a second capture', () => {
  /**
   * Three singleton controls in three discovery scopes. Each renders in a DOM
   * row of its own, so only a geometric row can put them on one line.
   */
  const singleton = (
    scopeName: string,
    coordinate: number,
    xStart: number,
    overrides: Partial<GeometryCapturedBlockCandidate> = {}
  ): GeometryCapturedBlockCandidate => ({
    elementId: `${scopeName}-icon:icon`,
    primitiveId: `${scopeName}-icon`,
    locator: {
      role: 'button',
      name: `${scopeName} action`,
      landmark: { role: 'banner', name: scopeName },
      rowFamily: `div[${scopeName}]>button[svg]`,
      roleIndex: 0,
    },
    label: 'icon',
    sectionScope: scopeName,
    rowId: `visual-row:${scopeName}`,
    rowFamily: `div[${scopeName}]>button[svg]`,
    kind: 'svg',
    space: 'ink',
    anchor: 'visual-center',
    coordinate,
    xStart,
    xEnd: xStart + 16,
    yStart: coordinate - 8,
    yEnd: coordinate + 8,
    ...overrides,
  });

  const rowCapture = (captureId: string, lastOffset: number): GeometryCapture => ({
    ...capture(captureId, [
      {
        key: 'shell',
        identity: 'shell',
        source: 'hint',
        depth: 2,
        rect: { x: 0, y: 0, width: 1440, height: 64 },
        candidates: [],
        blockCandidates: [
          singleton('sidebar.shell', 40, 24),
          singleton('session.topbar', 40, 320),
          singleton('session.info', 40 + lastOffset, 1200),
        ],
      },
    ]),
    viewport: { width: 1440, height: 900 },
  });
  const crossFamilyRails = (observation: ReturnType<typeof observeGeometryCaptures>) =>
    (observation.captures[0]?.blockRails ?? []).filter((rail) => rail.evidence === 'cross-family');

  it('proposes the rail in one capture and reports no finding for it', () => {
    const captureArtifact = { version: 1 as const, captures: [rowCapture('one', 2)] };
    const observation = observeGeometryCaptures(captureArtifact);

    const [rail] = crossFamilyRails(observation);
    expect(rail).toMatchObject({ anchor: 'visual-center', line: 40, sampleSize: 3 });
    expect(rail?.outliers.map((member) => member.elementId)).toEqual(['session.info-icon:icon']);
    // Nothing but the rendering says these three share a line, and one capture
    // agreeing is a coincidence: it stays a report proposal.
    expect(createGeometryFindings(captureArtifact, observation).findings).toEqual([]);
  });

  it('reports the outlier once the same members line up again in a second capture', () => {
    const captureArtifact = {
      version: 1 as const,
      captures: [rowCapture('one', 2), rowCapture('two', 2)],
    };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toEqual([
      expect.objectContaining({
        kind: 'cross-family',
        axis: 'y',
        anchor: 'visual-center',
        label: 'session.info action',
        offset: 2,
        captureCount: 2,
      }),
    ]);
    // The rail is not a finding; the element that leaves it is, and the whole
    // row travels as its evidence so a card annotates rather than measures.
    expect(findings.findings[0]?.evidence.map((item) => item.captureId)).toEqual(['one', 'two']);
    expect(findings.findings[0]?.evidence[0]?.rowMembers?.map((member) => member.outlier)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('keys the finding structurally, apart from the row-instance question', () => {
    const captureArtifact = {
      version: 1 as const,
      captures: [rowCapture('one', 2), rowCapture('two', 2)],
    };
    const [finding] = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    ).findings;
    const identity = geometryIdentityLocator(
      {
        role: 'button',
        name: 'session.info action',
        landmark: { role: 'banner', name: 'session.info' },
        rowFamily: 'div[session.info]>button[svg]',
        roleIndex: 0,
      },
      { section: 'session.info' }
    );

    expect(finding?.key).toBe(
      alignmentFindingKey({
        surfaceFamily: 'workspace',
        locator: identity,
        anchor: 'visual-center',
        axis: 'y',
        kind: 'cross-family',
      })
    );
    // Same element, same axis, same anchor: only the kind keeps them apart.
    expect(finding?.key).not.toBe(
      alignmentFindingKey({
        surfaceFamily: 'workspace',
        locator: identity,
        anchor: 'visual-center',
        axis: 'y',
      })
    );
  });

  it('matches members between captures structurally, never by coordinate', () => {
    // The whole line moved 6px down in the second capture. Same members, same
    // relationship to it, so the evidence still merges.
    const moved: GeometryCapture = {
      ...rowCapture('two', 2),
      scopes: [
        {
          ...(rowCapture('two', 2).scopes[0] as GeometryCapturedScope),
          blockCandidates: [
            singleton('sidebar.shell', 46, 24),
            singleton('session.topbar', 46, 320),
            singleton('session.info', 48, 1200),
          ],
        },
      ],
    };
    const captureArtifact = { version: 1 as const, captures: [rowCapture('one', 2), moved] };
    const findings = createGeometryFindings(
      captureArtifact,
      observeGeometryCaptures(captureArtifact)
    );

    expect(findings.findings).toHaveLength(1);
    expect(findings.findings[0]?.evidence.map((item) => item.line)).toEqual([40, 46]);
  });

  it('refuses an element that reads high in one capture and low in the next', () => {
    const captureArtifact = {
      version: 1 as const,
      captures: [rowCapture('one', 2), rowCapture('two', -2)],
    };

    expect(
      createGeometryFindings(captureArtifact, observeGeometryCaptures(captureArtifact)).findings
    ).toEqual([]);
  });

  it('leaves a DOM row to the row-instance path and never re-explains its members', () => {
    const rowMember = (
      primitiveId: string,
      coordinate: number,
      xStart: number
    ): GeometryCapturedBlockCandidate => ({
      ...singleton('sidebar.shell', coordinate, xStart),
      elementId: `${primitiveId}:label`,
      primitiveId,
      rowId: 'visual-row:sidebar-row',
      locator: {
        role: 'button',
        name: `Row ${primitiveId}`,
        landmark: { role: 'banner', name: 'sidebar.shell' },
        rowFamily: 'div[sidebar.shell]>button[svg]',
        roleIndex: 0,
      },
    });
    const withRow = (captureId: string): GeometryCapture => ({
      ...rowCapture(captureId, 2),
      scopes: [
        {
          ...(rowCapture(captureId, 2).scopes[0] as GeometryCapturedScope),
          blockCandidates: [
            rowMember('row-a', 40, 24),
            rowMember('row-b', 40, 60),
            rowMember('row-c', 42, 96),
            singleton('session.topbar', 40, 320),
            singleton('session.info', 40, 1200),
          ],
        },
      ],
    });
    const captureArtifact = { version: 1 as const, captures: [withRow('one'), withRow('two')] };
    const observation = observeGeometryCaptures(captureArtifact);

    // The DOM prior wins: the row explains its three members, and the two
    // singletons left on that geometric row are not three.
    expect(
      (observation.captures[0]?.blockRails ?? []).filter(
        (rail) => rail.evidence === 'row-instance'
      )[0]?.sampleSize
    ).toBe(3);
    expect(crossFamilyRails(observation)).toEqual([]);
    expect(
      createGeometryFindings(captureArtifact, observation).findings.map((finding) => finding.kind)
    ).toEqual(['alignment-rail']);
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

describe('geometry ledger ratchet', () => {
  const ratchetFinding = (
    key: string,
    offset: number,
    captureId = 'workspace:wide-expanded'
  ): GeometryFinding => ({
    key,
    kind: 'alignment-rail',
    surfaceFamily: 'workspace',
    locator: locator('Shifted'),
    label: `label for ${key}`,
    axis: 'x',
    anchor: 'inline-end',
    offset,
    captureCount: 1,
    totalCaptureCount: 1,
    evidence: [
      {
        captureId,
        scopeKey: 'sidebar.shell',
        coordinate: offset,
        line: 0,
        normalizedLine: 0.5,
        offset,
        yStart: 0,
        yEnd: 16,
      },
    ],
  });

  const captures = (scales: Readonly<Record<string, number>>): GeometryCaptureArtifact => ({
    version: 1,
    captures: Object.entries(scales).map(([captureId, deviceScaleFactor]) => ({
      captureId,
      surfaceFamily: 'workspace',
      surface: 'Workspace',
      storyId: 'story',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor,
      screenshot: '',
      scopes: [],
    })),
  });

  const retina = captures({ 'workspace:wide-expanded': 2 });

  it('allows a device pixel of drift above the reviewed baseline and no more', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: { 'geometry/workspace/a': { status: 'debt', baseline: { offset: -2 } } },
    };

    // 2.5 is exactly baseline + one device pixel at 2x; 2.51 is past it.
    expect(
      checkGeometryLedgerRatchet(
        { version: 1, findings: [ratchetFinding('geometry/workspace/a', 2.5)] },
        ledger,
        retina
      )
    ).toEqual([]);
    const regressed = checkGeometryLedgerRatchet(
      { version: 1, findings: [ratchetFinding('geometry/workspace/a', 2.51)] },
      ledger,
      retina
    );
    expect(regressed).toEqual([
      expect.objectContaining({
        kind: 'offset-regression',
        key: 'geometry/workspace/a',
        label: 'label for geometry/workspace/a',
        status: 'debt',
        baseline: -2,
        current: 2.51,
        tolerance: 0.5,
      }),
    ]);
    // The message has to carry enough to act on without opening the artifact.
    const message = formatGeometryRatchetViolations(regressed);
    expect(message).toContain('geometry/workspace/a');
    expect(message).toContain('baseline -2.000px → current 2.510px');
  });

  it('fails a finding no ledger entry reviews and says how to record it', () => {
    const violations = checkGeometryLedgerRatchet(
      { version: 1, findings: [ratchetFinding('geometry/workspace/unknown', 0.1)] },
      { version: 1, findings: {} },
      retina
    );

    expect(violations).toEqual([
      expect.objectContaining({ kind: 'unreviewed-finding', key: 'geometry/workspace/unknown' }),
    ]);
    expect(formatGeometryRatchetViolations(violations)).toContain('pnpm geometry:triage');
  });

  it('skips ignored entries and leaves promoted ones to the contract check', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: {
        'geometry/workspace/ignored': { status: 'ignored', baseline: { offset: 0 } },
        'geometry/workspace/promoted': {
          status: 'promoted',
          baseline: { offset: 0 },
          contract: {
            name: 'workspace.rail',
            story: 'geometry--landing',
            members: [locator('First'), locator('Second')],
            axis: 'x',
            anchor: 'inline-end',
            space: 'ink',
            tolerance: 0.5,
          },
        },
      },
    };

    expect(
      checkGeometryLedgerRatchet(
        {
          version: 1,
          findings: [
            ratchetFinding('geometry/workspace/ignored', 40),
            ratchetFinding('geometry/workspace/promoted', 40),
          ],
        },
        ledger,
        retina
      )
    ).toEqual([]);
  });

  it('holds a fixed finding to its near-zero baseline', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: { 'geometry/workspace/a': { status: 'fixed', baseline: { offset: 0 } } },
    };

    expect(
      checkGeometryLedgerRatchet(
        { version: 1, findings: [ratchetFinding('geometry/workspace/a', 1.2)] },
        ledger,
        retina
      )
    ).toEqual([
      expect.objectContaining({ kind: 'offset-regression', status: 'fixed', baseline: 0 }),
    ]);
  });

  it('takes its tolerance from the coarsest capture the finding was measured on', () => {
    const finding: GeometryFinding = {
      ...ratchetFinding('geometry/workspace/a', 1),
      evidence: [
        { ...ratchetFinding('geometry/workspace/a', 1).evidence[0]!, captureId: 'retina' },
        { ...ratchetFinding('geometry/workspace/a', 1).evidence[0]!, captureId: 'standard' },
      ],
    };
    const mixed = captures({ retina: 2, standard: 1 });

    expect(geometryFindingDevicePixel(finding, mixed)).toBe(1);
    // A finding merged across 1x and 2x is only as precise as the 1x capture.
    expect(
      checkGeometryLedgerRatchet(
        { version: 1, findings: [finding] },
        { version: 1, findings: { 'geometry/workspace/a': { status: 'debt', baseline: { offset: 0 } } } },
        mixed
      )
    ).toEqual([]);
  });

  it('marks a finding fixed only when it is inside one device pixel', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: {
        'geometry/workspace/a': { status: 'debt', baseline: { offset: -3 } },
        'geometry/workspace/b': { status: 'debt', baseline: { offset: 5 } },
      },
    };

    const still = verifyGeometryFixes(
      { version: 1, findings: [ratchetFinding('geometry/workspace/a', 1.5)] },
      ledger,
      retina,
      ['geometry/workspace/a']
    );
    expect(still.verifications[0]).toMatchObject({ passed: false });
    expect(still.verifications[0]?.reason).toContain('exceeds one device pixel');
    expect(still.ledger).toBe(ledger);

    const fixed = verifyGeometryFixes(
      { version: 1, findings: [ratchetFinding('geometry/workspace/a', 0.25)] },
      ledger,
      retina,
      ['geometry/workspace/a']
    );
    expect(fixed.verifications[0]).toMatchObject({ passed: true, offset: 0.25 });
    expect(fixed.ledger.findings['geometry/workspace/a']).toEqual({
      status: 'fixed',
      baseline: { offset: 0.25 },
    });
    // Untouched entries keep their review.
    expect(fixed.ledger.findings['geometry/workspace/b']).toEqual(
      ledger.findings['geometry/workspace/b']
    );
  });

  it('treats a finding no rail reports any more as fixed at zero', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: { 'geometry/workspace/a': { status: 'debt', baseline: { offset: -3 } } },
    };

    const result = verifyGeometryFixes({ version: 1, findings: [] }, ledger, retina, [
      'geometry/workspace/a',
    ]);

    expect(result.verifications[0]).toMatchObject({ passed: true, resolved: true });
    expect(result.ledger.findings['geometry/workspace/a']).toEqual({
      status: 'fixed',
      baseline: { offset: 0 },
    });
  });

  it('refuses to unpromote a finding its contract already gates', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: {
        'geometry/workspace/a': {
          status: 'promoted',
          baseline: { offset: 0 },
          contract: {
            name: 'workspace.rail',
            story: 'geometry--landing',
            members: [locator('First'), locator('Second')],
            axis: 'x',
            anchor: 'inline-end',
            space: 'ink',
            tolerance: 0.5,
          },
        },
      },
    };

    // Marking it `fixed` would stop compiling the contract and quietly drop the
    // tightest rule in the file.
    const result = verifyGeometryFixes(
      { version: 1, findings: [ratchetFinding('geometry/workspace/a', 0)] },
      ledger,
      retina,
      ['geometry/workspace/a']
    );

    expect(result.verifications[0]).toMatchObject({ passed: false });
    expect(result.verifications[0]?.reason).toContain('retire the contract');
    expect(result.ledger).toBe(ledger);
  });

  it('refuses to verify a finding no ledger entry reviews', () => {
    const result = verifyGeometryFixes(
      { version: 1, findings: [ratchetFinding('geometry/workspace/a', 0)] },
      { version: 1, findings: {} },
      retina,
      ['geometry/workspace/a']
    );

    expect(result.verifications[0]).toMatchObject({ passed: false });
    expect(result.verifications[0]?.reason).toContain('no ledger entry');
  });

  it('compiles no contract from a fixed, debt or wont-fix entry', () => {
    const ledger: GeometryLedger = {
      version: 1,
      findings: {
        'geometry/workspace/fixed': { status: 'fixed', baseline: { offset: 0 } },
        'geometry/workspace/debt': { status: 'debt', baseline: { offset: 2 } },
        'geometry/workspace/wont-fix': { status: 'wont-fix', baseline: { offset: 2 } },
      },
    };

    expect(compileGeometryContracts(ledger)).toEqual({ version: 1, contracts: [] });
  });
});

describe('geometry repair identity', () => {
  const proposal = (
    overrides: Partial<GeometryRepairProposal> & {
      term?: Partial<GeometryRepairProposal['terms'][number]>;
    } = {}
  ): GeometryRepairProposal => {
    const { term, ...rest } = overrides;
    return {
      commonAncestor: 'div[data-slot=sidebar-row]',
      component: 'SidebarRowShared',
      edge: 'inline-end',
      terms: [
        {
          side: 'member',
          term: 'padding',
          element: 'div[role=button]',
          className: 'pe-3',
          component: 'SidebarRowShared',
          memberValue: 12,
          referenceValue: 10,
          delta: 2,
          ...term,
        },
      ],
      ...rest,
    };
  };

  it('groups by the edit, not by the element that reported it', () => {
    const first = geometryRepairGroupKey(proposal());
    const sameEdit = geometryRepairGroupKey(
      // A different row, a different label, a different measured value: the
      // edit that closes it is the same one.
      proposal({ term: { memberValue: 14, referenceValue: 12, delta: 2, side: 'reference' } })
    );
    const otherComponent = geometryRepairGroupKey(
      proposal({ component: 'ProjectRow', term: { component: 'ProjectRow' } })
    );
    const otherEdge = geometryRepairGroupKey(proposal({ edge: 'inline-start' }));
    const otherTerm = geometryRepairGroupKey(proposal({ term: { term: 'margin' } }));

    expect(first).toBeDefined();
    expect(sameEdit).toBe(first);
    expect(otherComponent).not.toBe(first);
    expect(otherEdge).not.toBe(first);
    expect(otherTerm).not.toBe(first);
  });

  it('groups by the common ancestor when React rendered no component name', () => {
    const withoutComponent = proposal({ component: undefined, term: { component: undefined } });

    expect(geometryRepairGroupKey(withoutComponent)).toBeDefined();
    expect(geometryRepairGroupKey(withoutComponent)).not.toBe(geometryRepairGroupKey(proposal()));
  });

  it('has no group when there is nothing to repair', () => {
    expect(geometryRepairGroupKey({ ...proposal(), terms: [] })).toBeUndefined();
  });

  it('names the CSS property an agent would actually edit', () => {
    expect(geometryRepairCssProperty('padding', 'inline-end')).toBe('padding-inline-end');
    expect(geometryRepairCssProperty('margin', 'block-start')).toBe('margin-block-start');
    expect(geometryRepairCssProperty('border', 'inline-start')).toBe('border-inline-start-width');
    // A gap belongs to the axis; `gap-inline-end` is not a property.
    expect(geometryRepairCssProperty('gap', 'inline-end')).toBe('column-gap');
    expect(geometryRepairCssProperty('gap', 'block-end')).toBe('row-gap');
  });

  it('renders a repair a reader can act on without opening the artifact', () => {
    expect(formatGeometryRepairProposal(proposal())).toBe(
      'SidebarRowShared 里 div[role=button] 的 padding-inline-end 多 2px（class: pe-3）'
    );
    expect(
      formatGeometryRepairProposal(proposal({ term: { className: undefined, delta: -2 } }))
    ).toBe('SidebarRowShared 里 div[role=button] 的 padding-inline-end 少 2px');
  });

  it('leaves the class list out where a whole class list would not fit', () => {
    // A real Tailwind class list is hundreds of characters. The card body keeps
    // it whole, because half of one greps for nothing; the one-line summary
    // drops it rather than truncate it.
    expect(formatGeometryRepairProposal(proposal(), { includeClassName: false })).toBe(
      'SidebarRowShared 里 div[role=button] 的 padding-inline-end 多 2px'
    );
  });

  it('falls back to the common ancestor when React rendered no component name', () => {
    // A node React never rendered still gets a sentence, just a less precise one.
    expect(
      formatGeometryRepairProposal(
        proposal({ component: undefined, term: { component: undefined } })
      )
    ).toBe(
      'div[data-slot=sidebar-row] 里 div[role=button] 的 padding-inline-end 多 2px（class: pe-3）'
    );
  });

  it('collects every finding one repair group covers', () => {
    const artifact: GeometryFindingArtifact = {
      version: 1,
      findings: [
        { ...ratchetLikeFinding('geometry/workspace/a'), repairGroup: 'geometry/repair/x' },
        { ...ratchetLikeFinding('geometry/workspace/c'), repairGroup: 'geometry/repair/x' },
        { ...ratchetLikeFinding('geometry/workspace/b'), repairGroup: 'geometry/repair/y' },
        ratchetLikeFinding('geometry/workspace/d'),
      ],
    };

    expect(geometryFindingKeysInRepairGroup(artifact, 'geometry/repair/x')).toEqual([
      'geometry/workspace/a',
      'geometry/workspace/c',
    ]);
    expect(geometryFindingKeysInRepairGroup(artifact, 'geometry/repair/missing')).toEqual([]);
  });
});

function ratchetLikeFinding(key: string): GeometryFinding {
  return {
    key,
    kind: 'alignment-rail',
    surfaceFamily: 'workspace',
    label: key,
    axis: 'x',
    anchor: 'inline-end',
    offset: 1,
    captureCount: 1,
    totalCaptureCount: 1,
    evidence: [],
  };
}
