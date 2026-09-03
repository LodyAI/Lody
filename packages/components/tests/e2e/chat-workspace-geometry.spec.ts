import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
  CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES,
  type DiscoveredBlockRail,
  resolveMainPaneGridRange,
  validateChatWorkspaceGeometry,
} from '../../src/lib/chat-workspace-geometry';
import {
  checkGeometryLedgerRatchet,
  compileGeometryContracts,
  formatGeometryRatchetViolations,
  geometryFindingKeysInRepairGroup,
  verifyGeometryFixes,
  type GeometryContractArtifact,
  type GeometryLedger,
  type GeometryObservationCache,
} from '../../src/lib/geometry-constraint-system';
import {
  GEOMETRY_CAPTURE_PLAN,
  runGeometryCapturePlan,
  runGeometryFindingPipeline,
} from './support/geometry-capture-plan';
import {
  auditChatWorkspaceSemanticAlignments,
  captureChatWorkspaceGeometryScopes,
  auditChatWorkspaceSemanticBaselines,
  auditChatWorkspaceSpacing,
  discoverChatWorkspaceAlignmentRails,
  discoverChatWorkspaceBlockRails,
  formatGeometryViolations,
  measureSettledChatWorkspace,
  requireGeometryRect,
  validateCompiledGeometryContracts,
} from './support/chat-workspace-geometry';

/**
 * Set to write `capture.json` / `observation.json` / `findings.json` beside the
 * ratchet run. `pnpm geometry:verify-fix` reads them; CI does not need them and
 * does not set this, so the gate stays a measurement with no artifacts.
 */
const pipelineOutputDirectory = process.env.GEOMETRY_PIPELINE_OUTPUT_DIR;
/**
 * `pnpm geometry:verify-fix` sets these. The DECISION — is this finding fixed,
 * and what does the ledger become — is made here in TypeScript, beside the
 * ratchet it must not regress; the script only applies the file it writes.
 */
const verifyFixKeys = (process.env.GEOMETRY_VERIFY_FIX_KEYS ?? '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const verifyFixRepairGroup = process.env.GEOMETRY_VERIFY_FIX_REPAIR_GROUP;

const STORY_IDS = {
  expanded: 'geometry-chatworkspace--expanded-sidebar',
  collapsed: 'geometry-chatworkspace--collapsed-sidebar',
} as const;
const storybookOrigin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:6006';

test('compiled promoted geometry contracts are current and pass by stable locator', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const [ledgerText, contractsText] = await Promise.all([
    readFile(new URL('../../geometry-ledger.json', import.meta.url), 'utf8'),
    readFile(new URL('../../geometry-contracts.json', import.meta.url), 'utf8'),
  ]);
  const ledger = JSON.parse(ledgerText) as GeometryLedger;
  const contracts = JSON.parse(contractsText) as GeometryContractArtifact;
  expect(contracts).toEqual(compileGeometryContracts(ledger));

  const storyIds = [...new Set(contracts.contracts.map((contract) => contract.story))];
  const violations: string[] = [];
  for (const storyId of storyIds) {
    const response = await page.goto(`/iframe.html?id=${storyId}&viewMode=story`);
    expect(response?.ok(), storyId).toBeTruthy();
    await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
      timeout: 150_000,
    });
    violations.push(...(await validateCompiledGeometryContracts(page, contracts, storyId)));
  }
  expect(violations).toEqual([]);
});

/**
 * The ratchet. Every other test here proves a RULE; this one proves the LEDGER,
 * which until now was a file the report printed and nothing executed: a
 * baseline could be exceeded, and a brand new finding could appear, with every
 * check still green.
 *
 * It runs the same `capture → observation → findings` pipeline the report runs,
 * over the same capture plan, with no screenshots — the screenshots are what
 * make the report a 40-minute review artifact, and none of them are evidence.
 */
test('every measured geometry finding stays inside its reviewed ledger baseline', async ({
  browser,
}) => {
  test.setTimeout(1_800_000);
  const ledger = JSON.parse(
    await readFile(new URL('../../geometry-ledger.json', import.meta.url), 'utf8')
  ) as GeometryLedger;

  const observationCache: GeometryObservationCache = new Map();
  const blockedRequests: string[] = [];
  const capture = await runGeometryCapturePlan(browser, GEOMETRY_CAPTURE_PLAN, {
    observationCache,
    blockedRequests,
  });
  expect(blockedRequests, 'Geometry fixture made an external request').toEqual([]);
  const { observation, findings } = runGeometryFindingPipeline(capture);

  if (pipelineOutputDirectory) {
    await mkdir(pipelineOutputDirectory, { recursive: true });
    for (const [name, artifact] of [
      ['capture.json', capture],
      ['observation.json', observation],
      ['findings.json', findings],
    ] as const) {
      await writeFile(
        path.join(pipelineOutputDirectory, name),
        `${JSON.stringify(artifact, null, 2)}\n`,
        'utf8'
      );
    }
  }

  const violations = checkGeometryLedgerRatchet(findings, ledger, capture);
  expect(
    violations,
    `Geometry ledger ratchet failed:\n\n${formatGeometryRatchetViolations(violations)}`
  ).toEqual([]);

  if (!pipelineOutputDirectory || (verifyFixKeys.length === 0 && !verifyFixRepairGroup)) return;
  const keys = [
    ...new Set([
      ...verifyFixKeys,
      ...(verifyFixRepairGroup
        ? geometryFindingKeysInRepairGroup(findings, verifyFixRepairGroup)
        : []),
    ]),
  ];
  expect(keys, 'No finding matches the requested keys or repair group').not.toEqual([]);
  const verification = verifyGeometryFixes(findings, ledger, capture, keys);
  await writeFile(
    path.join(pipelineOutputDirectory, 'fix-verification.json'),
    `${JSON.stringify(
      {
        version: 1,
        passed: verification.verifications.every((item) => item.passed),
        verifications: verification.verifications,
        ledger: verification.ledger,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
});

for (const verificationCase of CHAT_WORKSPACE_GEOMETRY_SPEC.verificationCases) {
  test(`${verificationCase.name} satisfies the authenticated chat workspace contract`, async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: verificationCase.viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });
    const unexpectedNetworkRequests: string[] = [];
    await context.route(/https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === storybookOrigin) {
        await route.continue();
        return;
      }
      unexpectedNetworkRequests.push(url.href);
      await route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    const storyId = STORY_IDS[verificationCase.sidebar];
    const storyUrl = `${storybookOrigin}/iframe.html?id=${storyId}&viewMode=story`;
    const response = await page.goto(storyUrl);
    expect(response?.ok(), `Story iframe did not return 2xx for ${storyId}`).toBeTruthy();

    await expect(page.locator('[data-geometry-fixture-view="production"]')).toBeAttached({
      timeout: 30_000,
    });
    await expect(page.locator('#chat-prompt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Machine' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Permission' })).toBeVisible();

    const measurement = await measureSettledChatWorkspace(page);
    const violations = validateChatWorkspaceGeometry(measurement.snapshot, {
      sidebar: verificationCase.sidebar,
      spacingMeasurements: measurement.spacingMeasurements,
    });
    expect(
      violations,
      `Geometry contract failed:\n${formatGeometryViolations(violations)}`
    ).toEqual([]);

    const shell = requireGeometryRect(
      measurement.snapshot,
      CHAT_WORKSPACE_GEOMETRY_ANCHORS.workspaceShell
    );
    expect(shell).toEqual({
      x: 0,
      y: 0,
      width: verificationCase.viewport.width,
      height: verificationCase.viewport.height,
    });

    const mainPane = requireGeometryRect(
      measurement.snapshot,
      CHAT_WORKSPACE_GEOMETRY_ANCHORS.mainPane
    );
    expect(resolveMainPaneGridRange(mainPane.width).name).toBe(verificationCase.expectedGridRange);

    if (verificationCase.sidebarWidth != null) {
      const sidebarCard = requireGeometryRect(
        measurement.snapshot,
        CHAT_WORKSPACE_GEOMETRY_ANCHORS.sidebarCard
      );
      expect(sidebarCard.width).toBe(verificationCase.sidebarWidth);
    }

    if (process.env.GEOMETRY_DIAGNOSTIC_AUDIT === '1') {
      const spacingAudit = await auditChatWorkspaceSpacing(page);
      const semanticAlignments = await auditChatWorkspaceSemanticAlignments(page);
      const semanticBaselines = await auditChatWorkspaceSemanticBaselines(page);
      // eslint-disable-next-line no-console -- explicit local audit mode prints the migration inventory.
      console.log(
        `GEOMETRY_AUDIT ${verificationCase.name}\n${JSON.stringify(
          { spacingAudit, semanticAlignments, semanticBaselines },
          null,
          2
        )}`
      );
    }

    expect(unexpectedNetworkRequests, 'Geometry fixture made an external request').toEqual([]);
    await context.close();
  });
}

test('capture names a content-named tab exactly as Playwright resolves it', async ({ page }) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=sessions-sessionsidepaneltabbar--geometry-report&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 30_000 });

  const scopes = await captureChatWorkspaceGeometryScopes(page, {
    aggregateScopes: ['session.side-panel'],
  });
  const tabLocators = scopes.flatMap((scope) =>
    scope.candidates.flatMap((candidate) =>
      candidate.locator.role === 'tab' ? [candidate.locator] : []
    )
  );
  expect(tabLocators.length).toBeGreaterThan(0);
  // The Files tab used to reach findings with no name at all, because naming
  // only read aria-label/title. It is now named from its own content.
  const filesTab = tabLocators.find((locator) => locator.name?.startsWith('Files'));
  expect(filesTab?.name).toBeDefined();
  // Capture and gate must agree: the same name resolves to exactly one element
  // through Playwright's own role engine.
  await expect(page.getByRole('tab', { name: filesTab?.name ?? '', exact: true })).toHaveCount(1);
});

test('visible sidebar rails are inferred without geometry marker attributes', async ({ page }) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 30_000,
  });

  const semanticAttributes = Object.values(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES);
  await page.locator('*').evaluateAll((elements, attributes) => {
    for (const element of elements) {
      for (const attribute of attributes) element.removeAttribute(attribute);
    }
  }, semanticAttributes);
  await page
    .locator(`[${CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE}]`)
    .evaluateAll((elements, attribute) => {
      for (const element of elements) element.removeAttribute(attribute);
    }, CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE);

  // Outlier reporting is proven with a deviation this test injects itself, not with
  // one standing in the product. Asserting a real misalignment here would make the
  // gate fail the moment someone corrects it, which is exactly backwards.
  const probeLabel = 'Geometry outlier probe';
  const probeShift = 5;
  await page
    .locator('[aria-label="Archive"]')
    .first()
    .evaluate(
      (element, { label, shift }) => {
        element.setAttribute('aria-label', label);
        const style = (element as HTMLElement).style;
        style.position = 'relative';
        style.left = `${shift}px`;
      },
      { label: probeLabel, shift: probeShift }
    );

  const discovery = await discoverChatWorkspaceAlignmentRails(page);
  const capturedLocators = discovery.flatMap((scope) =>
    scope.capturedScope.candidates.map((candidate) => candidate.locator)
  );
  // Accessible names now come from the shared accname subset, so every widget is
  // named; only plain flow text still needs the structural fallback.
  const unnamedLocators = capturedLocators.filter((locator) => !locator.name);
  expect(unnamedLocators.length).toBeGreaterThan(0);
  expect(
    unnamedLocators.every(
      (locator) =>
        Boolean(locator.rowFamily) &&
        Number.isInteger(locator.roleIndex) &&
        (locator.roleIndex ?? -1) >= 0
    )
  ).toBe(true);
  const namedProbe = capturedLocators.find((locator) => locator.name === probeLabel);
  expect(namedProbe?.role).toBe('button');
  expect(discovery.filter((scope) => scope.source === 'hint')).toEqual([]);
  const autoScopes = discovery.filter((scope) => scope.source === 'auto');
  expect(
    autoScopes.some((scope) => (scope.topology?.instanceCount ?? 0) >= 3 && scope.rails.length > 0)
  ).toBe(true);
  const autoRails = autoScopes.flatMap((scope) => scope.rails);
  const trailingRail = autoRails.find(
    (rail) =>
      rail.anchor === 'inline-end' &&
      rail.space === 'ink' &&
      rail.members.some(
        (member) => (member as typeof member & { label?: string }).label === 'Archive'
      ) &&
      rail.outliers.some(
        (member) => (member as typeof member & { label?: string }).label === probeLabel
      )
  );

  expect(trailingRail).toMatchObject({
    anchor: 'inline-end',
    space: 'ink',
  });
  // The unshifted siblings still hold the line the probe departed from.
  expect(trailingRail?.support).toBeGreaterThanOrEqual(3);
  const probeOutlier = trailingRail?.outliers.find(
    (member) => (member as typeof member & { label?: string }).label === probeLabel
  );
  expect(probeOutlier?.delta).toBeGreaterThan(probeShift - 1);
  expect(probeOutlier?.delta).toBeLessThan(probeShift + 1);
});

test('vertical row alignment is discovered without geometry marker attributes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 30_000,
  });

  const semanticAttributes = Object.values(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES);
  await page.locator('*').evaluateAll((elements, attributes) => {
    for (const element of elements) {
      for (const attribute of attributes) element.removeAttribute(attribute);
    }
  }, semanticAttributes);
  await page
    .locator(`[${CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE}]`)
    .evaluateAll((elements, attribute) => {
      for (const element of elements) element.removeAttribute(attribute);
    }, CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE);

  // Only the rows capture forms from rendered geometry are compared before and
  // after: an automatic topology scope is keyed by a structural hash, so moving
  // a glyph inside it may legitimately rename its rows.
  const visualRows = (rails: readonly DiscoveredBlockRail[]) =>
    rails.filter((rail) => rail.anchor === 'visual-center' && rail.rowId.startsWith('visual-row:'));
  const outliersByRow = (rails: readonly DiscoveredBlockRail[]) =>
    new Map(
      visualRows(rails).map((rail) => [
        rail.rowId,
        rail.outliers
          .map((member) => (member as typeof member & { primitiveId?: string }).primitiveId ?? '')
          .sort()
          .join(','),
      ])
    );

  const before = await discoverChatWorkspaceBlockRails(page);
  expect(visualRows(before).length).toBeGreaterThan(0);
  // An odd, tight row: the median is then one member's coordinate, so a shift
  // moves the probe and not the line it is measured against.
  const target = visualRows(before).find(
    (rail) =>
      rail.sampleSize >= 3 &&
      rail.sampleSize % 2 === 1 &&
      rail.spread <= 1 &&
      rail.members.some((member) => member.kind === 'svg' && !member.outlier)
  );
  const probe = target?.members.find((member) => member.kind === 'svg' && !member.outlier) as
    | (NonNullable<typeof target>['members'][number] & { primitiveId?: string })
    | undefined;
  expect(target, 'no odd, tight visual row with an aligned icon to probe').toBeDefined();
  expect(probe?.primitiveId).toBeDefined();

  const probeShift = 3;
  await page.evaluate(
    ({ primitiveId, shift }) => {
      const index = Number(primitiveId.replace('dom-', '')) - 1;
      const element = [document.body, ...document.body.querySelectorAll('*')][index];
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
        throw new Error(`Geometry probe element ${primitiveId} is missing`);
      }
      element.style.transform = `translateY(${shift}px)`;
    },
    { primitiveId: probe?.primitiveId ?? '', shift: probeShift }
  );

  const after = await discoverChatWorkspaceBlockRails(page);
  const probedRow = visualRows(after).find((rail) => rail.rowId === target?.rowId);
  const probedMember = probedRow?.members.find(
    (member) =>
      (member as typeof member & { primitiveId?: string }).primitiveId === probe?.primitiveId
  );
  expect(probedMember?.outlier).toBe(true);
  const probedOffset = Math.abs((probedMember?.coordinate ?? 0) - (probedRow?.line ?? 0));
  expect(probedOffset).toBeGreaterThan(probeShift - 1);
  expect(probedOffset).toBeLessThan(probeShift + 1);

  // Only that row moved. Comparing the two runs, rather than asserting which
  // product rows are aligned, keeps the gate from failing when a real vertical
  // offset elsewhere is fixed.
  const changedRows = [...outliersByRow(after).entries()].filter(
    ([rowId, outliers]) => outliersByRow(before).get(rowId) !== outliers
  );
  expect(changedRows.map(([rowId]) => rowId)).toEqual([target?.rowId]);
});

test('a cross-family geometric row reports its outlier and no DOM row', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.goto(
    '/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 30_000,
  });

  // The discovery-scope attribute stays: it is a declared hint, and it is half
  // of what sets a rail's evidence bar. The alignment markers go, so nothing a
  // designer wrote can be what put these controls on one line.
  const semanticAttributes = Object.values(CHAT_WORKSPACE_SEMANTIC_ALIGNMENT_ATTRIBUTES);
  await page.locator('*').evaluateAll((elements, attributes) => {
    for (const element of elements) {
      for (const attribute of attributes) element.removeAttribute(attribute);
    }
  }, semanticAttributes);

  type Identified = Readonly<{ primitiveId?: string }>;
  const primitiveIdOf = (member: Identified) => member.primitiveId ?? '';
  const outlierIds = (rail: DiscoveredBlockRail) =>
    rail.outliers
      .map((member) => primitiveIdOf(member as typeof member & Identified))
      .sort()
      .join(',');
  const memberIds = (rail: DiscoveredBlockRail) =>
    rail.members
      .map((member) => primitiveIdOf(member as typeof member & Identified))
      .sort()
      .join(',');
  const outliersByRail = (rails: readonly DiscoveredBlockRail[]) =>
    new Map(
      rails.map((rail) => [`${rail.evidence} ${memberIds(rail)} ${rail.anchor}`, outlierIds(rail)])
    );
  const crossFamily = (rails: readonly DiscoveredBlockRail[]) =>
    rails.filter((rail) => rail.evidence === 'cross-family');
  const rowInstance = (rails: readonly DiscoveredBlockRail[]) =>
    rails.filter((rail) => rail.evidence === 'row-instance');

  const before = await discoverChatWorkspaceBlockRails(page);
  expect(crossFamily(before).length, 'no cross-family geometric row to probe').toBeGreaterThan(0);

  // Any singleton control on any cross-family row will do; naming a header icon
  // would make the gate about one product surface rather than about the rule.
  // An odd, tight rail: the median is then one member's coordinate, so the shift
  // moves the probe and not the line it is measured against.
  const probeOf = (rail: DiscoveredBlockRail) =>
    rail.members.find((member) => !member.outlier && member.kind === 'svg');
  const target = crossFamily(before).find(
    (rail) => rail.sampleSize % 2 === 1 && rail.spread <= 1 && probeOf(rail) !== undefined
  );
  expect(target, 'no tight cross-family row with an aligned icon to probe').toBeDefined();
  if (!target) return;
  const probe = probeOf(target);
  const probeId = probe ? primitiveIdOf(probe as typeof probe & Identified) : '';
  expect(probeId).not.toBe('');

  const probeShift = 2;
  await page.evaluate(
    ({ primitiveId, shift }) => {
      const index = Number(primitiveId.replace('dom-', '')) - 1;
      const element = [document.body, ...document.body.querySelectorAll('*')][index];
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
        throw new Error(`Geometry probe element ${primitiveId} is missing`);
      }
      element.style.transform = `translateY(${shift}px)`;
    },
    { primitiveId: probeId, shift: probeShift }
  );

  const after = await discoverChatWorkspaceBlockRails(page);
  const probed = crossFamily(after).find((rail) => memberIds(rail) === memberIds(target));
  const probedMember = probed?.members.find(
    (member) => primitiveIdOf(member as typeof member & Identified) === probeId
  );
  expect(probedMember?.outlier).toBe(true);
  const probedOffset = (probedMember?.coordinate ?? 0) - (probed?.line ?? 0);
  expect(probedOffset).toBeGreaterThan(probeShift - 1);
  expect(probedOffset).toBeLessThan(probeShift + 1);

  // Only the injected element left its rail, and it is the only element added to
  // that rail's outliers. Comparing the two runs, rather than asserting which
  // product rows are aligned, keeps the gate from failing when a real offset
  // elsewhere is fixed.
  const changed = [...outliersByRail(after).entries()].filter(
    ([key, outliers]) => outliersByRail(before).get(key) !== outliers
  );
  expect(changed.map(([key]) => key)).toEqual([
    `cross-family ${memberIds(target)} ${target.anchor}`,
  ]);
  expect(probed ? outlierIds(probed) : '').toBe(
    [...new Set([...outlierIds(target).split(',').filter(Boolean), probeId])].sort().join(',')
  );
  // No product DOM row was touched: the DOM prior decides the evidence bar, and
  // a cross-family probe must not reach a row-instance rail at all.
  expect(rowInstance(after).length).toBe(rowInstance(before).length);
});

if (process.env.GEOMETRY_DIAGNOSTIC_AUDIT === '1') {
  test('geometry audit exposes every guide and diagnostic without hover', async ({ page }) => {
    test.setTimeout(60_000);
    const response = await page.goto(
      '/iframe.html?id=geometry-chatworkspace--geometry-audit&viewMode=story'
    );
    expect(response?.ok()).toBeTruthy();
    await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
      timeout: 30_000,
    });

    const spacingOverlay = page.locator('[data-geometry-devtool="spacing-audit"]');
    await expect(spacingOverlay).toBeAttached();
    await expect
      .poll(async () =>
        Number(await spacingOverlay.getAttribute('data-geometry-spacing-violation-count'))
      )
      .toBeGreaterThan(0);

    const declaredCount = Number(
      await spacingOverlay.getAttribute('data-geometry-spacing-violation-count')
    );
    const visibleMarkers = spacingOverlay.locator('[data-geometry-spacing-scope]');
    await expect(visibleMarkers).toHaveCount(declaredCount);
    expect(
      await spacingOverlay.locator('[data-geometry-spacing-scope="workspace-sidebar-card"]').count()
    ).toBeGreaterThan(0);
    for (let index = 0; index < declaredCount; index += 1) {
      await expect(visibleMarkers.nth(index)).toBeVisible();
    }

    const baselineOverlay = page.locator('[data-geometry-devtool="semantic-baselines"]');
    await expect(baselineOverlay).toBeAttached();
    const baselineGroups = Number(
      await baselineOverlay.getAttribute('data-geometry-baseline-group-count')
    );
    expect(baselineGroups).toBe(0);
    const baselineLines = baselineOverlay.locator('[data-geometry-baseline-aligned]');
    await expect(baselineLines).toHaveCount(baselineGroups);
    for (let index = 0; index < baselineGroups; index += 1) {
      await expect(baselineLines.nth(index)).toBeVisible();
    }

    const alignmentOverlay = page.locator('[data-geometry-devtool="semantic-alignments"]');
    await expect(alignmentOverlay).toBeAttached();
    const alignmentGroups = Number(
      await alignmentOverlay.getAttribute('data-geometry-alignment-group-count')
    );
    expect(alignmentGroups).toBeGreaterThan(0);
    await expect(alignmentOverlay.locator('[data-geometry-alignment-axis]')).toHaveCount(
      alignmentGroups
    );
    const visualCenters = alignmentOverlay.locator(
      '[data-geometry-alignment-anchor="visual-center"]'
    );
    expect(await visualCenters.count()).toBeGreaterThan(0);
    const trailingRail = alignmentOverlay.locator(
      '[data-geometry-alignment-name="sidebar.primary-trailing-rail-end"]'
    );
    await expect(trailingRail).toHaveAttribute('data-geometry-alignment-axis', 'x');
    await expect(trailingRail).toHaveAttribute('data-geometry-alignment-aligned', 'false');
    expect(
      Number(await trailingRail.getAttribute('data-geometry-alignment-spread'))
    ).toBeGreaterThan(0.5);

    const hoverActions = page.locator(
      '[data-geometry-actions-visible="true"] [data-geometry-hover-action]'
    );
    expect(await hoverActions.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await hoverActions.count()); index += 1) {
      await expect(hoverActions.nth(index)).toHaveCSS('opacity', '1');
    }
    const hoverRestContent = page.locator(
      '[data-geometry-actions-visible="true"] [data-geometry-hover-rest]'
    );
    expect(await hoverRestContent.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await hoverRestContent.count()); index += 1) {
      await expect(hoverRestContent.nth(index)).toHaveCSS('opacity', '0');
    }

    await expect(page.locator('[data-geometry-grid-scope="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-geometry-grid-scope="main"]')).toBeVisible();
  });
}
