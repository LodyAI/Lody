// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import { ArchiveListWindow } from '../src/components/archive/archive-list-window';
import {
  ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX,
  ARCHIVE_LIST_OVERSCAN,
  archiveRowDataId,
  estimateArchiveRowSize,
  flattenVisibleArchiveRows,
  type ArchiveListGroupInput,
  type ArchiveVirtualRow,
} from '../src/lib/archive-list-virtualization';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_HEIGHT_PX = 400;
const GROUP_COUNT = 4;
const SESSIONS_PER_GROUP = 50;
const SESSION_COUNT = GROUP_COUNT * SESSIONS_PER_GROUP;

let viewportHeightPx = VIEWPORT_HEIGHT_PX;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function installLayoutStubs(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-archive-list-scroll') ? viewportHeightPx : 0;
    },
  });
}

function session(id: string): SessionMeta {
  return { id: id as SessionId, title: id } as SessionMeta;
}

function makeGroups(): ArchiveListGroupInput[] {
  return Array.from({ length: GROUP_COUNT }, (_, groupIndex) => ({
    key: `acme/repo-${groupIndex}`,
    kind: 'repo' as const,
    collapsed: false,
    sessions: Array.from({ length: SESSIONS_PER_GROUP }, (_session, sessionIndex) =>
      session(`s-${groupIndex}-${sessionIndex}`)
    ),
  }));
}

function renderRow(row: ArchiveVirtualRow): ReactNode {
  return (
    <div data-id={archiveRowDataId(row)} data-scope-item="row">
      {row.key}
    </div>
  );
}

function countSessions(host: HTMLElement): number {
  return host.querySelectorAll('[data-id^="archive-session:"]').length;
}

function countHeaders(host: HTMLElement): number {
  return host.querySelectorAll('[data-id^="archive-group:"]').length;
}

describe('ArchiveListWindow virtualization', () => {
  const roots: Root[] = [];
  const hosts: HTMLDivElement[] = [];

  beforeEach(() => {
    viewportHeightPx = VIEWPORT_HEIGHT_PX;
    installLayoutStubs();
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    for (const host of hosts.splice(0)) host.remove();
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  });

  async function renderWindow(node: ReactNode): Promise<HTMLDivElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(node);
    });
    return host;
  }

  it('compares static vs virtualized initialization on a long grouped list', async () => {
    const groups = makeGroups();
    const rows = flattenVisibleArchiveRows(groups, { hideGroupHeader: false });
    const expectedSpacerPx = rows.reduce(
      (sum, row) => sum + estimateArchiveRowSize(row, { isMobile: false }),
      0
    );
    const windowCeiling =
      Math.ceil(VIEWPORT_HEIGHT_PX / ARCHIVE_DESKTOP_SESSION_ROW_ESTIMATE_PX) +
      2 * ARCHIVE_LIST_OVERSCAN;

    const staticHost = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-static"
        renderRow={renderRow}
        virtualizeThreshold={Number.POSITIVE_INFINITY}
      />
    );
    const virtualHost = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-virtualized"
        renderRow={renderRow}
      />
    );

    const staticSessions = countSessions(staticHost);
    const virtualSessions = countSessions(virtualHost);
    const staticNodes = staticHost.querySelectorAll('*').length;
    const virtualNodes = virtualHost.querySelectorAll('*').length;

    expect(staticHost.querySelector('[data-archive-list="static"]')).not.toBeNull();
    expect(virtualHost.querySelector('[data-archive-list="virtualized"]')).not.toBeNull();
    expect(staticSessions).toBe(SESSION_COUNT);
    expect(countHeaders(staticHost)).toBe(GROUP_COUNT);
    expect(virtualSessions + countHeaders(virtualHost)).toBeLessThanOrEqual(windowCeiling);
    expect(virtualNodes).toBeLessThan(staticNodes / 2);
    expect(virtualHost.querySelector('[data-id="archive-group:acme/repo-0"]')).not.toBeNull();
    expect(virtualHost.querySelector('[data-id="archive-session:s-0-0"]')).not.toBeNull();
    expect(
      (virtualHost.querySelector('[data-archive-list="virtualized"]') as HTMLElement | null)?.style
        .height
    ).toBe(`${expectedSpacerPx}px`);
  });

  it('mounts no rows rather than the whole list while the scrollport measures 0', async () => {
    viewportHeightPx = 0;
    const rows = flattenVisibleArchiveRows(makeGroups(), { hideGroupHeader: false });
    const host = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-empty-range"
        renderRow={renderRow}
      />
    );
    expect(countSessions(host)).toBe(0);
    expect(countHeaders(host)).toBe(0);
    expect(host.querySelector('[data-archive-list="virtualized"]')).not.toBeNull();
  });

  it('renders every row without a spacer for a small grouped list', async () => {
    const rows = flattenVisibleArchiveRows(
      [
        {
          key: 'acme/small',
          kind: 'repo',
          collapsed: false,
          sessions: [session('a'), session('b')],
        },
      ],
      { hideGroupHeader: false }
    );
    const host = await renderWindow(
      <ArchiveListWindow
        rows={rows}
        isMobile={false}
        listScopeId="archive-small"
        renderRow={renderRow}
      />
    );
    expect(host.querySelector('[data-archive-list="static"]')).not.toBeNull();
    expect(countSessions(host)).toBe(2);
    expect(countHeaders(host)).toBe(1);
  });
});
