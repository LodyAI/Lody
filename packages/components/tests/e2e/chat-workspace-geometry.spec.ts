import { expect, test } from '@playwright/test';

import {
  CHAT_WORKSPACE_GEOMETRY_ANCHORS,
  CHAT_WORKSPACE_GEOMETRY_SPEC,
  CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE,
  resolveMainPaneGridRange,
  validateChatWorkspaceGeometry,
} from '../../src/lib/chat-workspace-geometry';
import {
  auditChatWorkspaceSemanticAlignments,
  auditChatWorkspaceSemanticBaselines,
  auditChatWorkspaceSpacing,
  discoverChatWorkspaceAlignmentRails,
  formatGeometryViolations,
  measureSettledChatWorkspace,
  requireGeometryRect,
} from './support/chat-workspace-geometry';

const STORY_IDS = {
  expanded: 'geometry-chatworkspace--expanded-sidebar',
  collapsed: 'geometry-chatworkspace--collapsed-sidebar',
} as const;

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
      if (url.origin === 'http://127.0.0.1:6006') {
        await route.continue();
        return;
      }
      unexpectedNetworkRequests.push(url.href);
      await route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    const storyId = STORY_IDS[verificationCase.sidebar];
    const storyUrl = `http://127.0.0.1:6006/iframe.html?id=${storyId}&viewMode=story`;
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

test('alignment rails are discovered without manual scope attributes', async ({ page }) => {
  test.setTimeout(60_000);
  const response = await page.goto(
    '/iframe.html?id=geometry-chatworkspace--expanded-sidebar&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('[data-geometry-fixture-ready="true"]')).toBeAttached({
    timeout: 30_000,
  });
  await page
    .locator(`[${CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE}]`)
    .evaluateAll((elements, attribute) => {
      for (const element of elements) element.removeAttribute(attribute);
    }, CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE);

  const discovery = await discoverChatWorkspaceAlignmentRails(page);
  expect(discovery.filter((scope) => scope.source === 'hint')).toEqual([]);
  expect(
    discovery.some(
      (scope) =>
        scope.source === 'auto' &&
        (scope.topology?.instanceCount ?? 0) >= 3 &&
        scope.rails.length > 0
    )
  ).toBe(true);
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
