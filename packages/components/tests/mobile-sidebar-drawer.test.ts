import { describe, expect, it } from 'vitest';
import {
  resolveMobileDrawerWidth,
  shouldIgnoreSidebarSwipeGesture,
} from '../src/components/mobile/mobile-sidebar-drawer';

type FakeElement = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  dataset?: Record<string, string | undefined>;
  parentElement?: FakeElement | null;
};

type FakeSelection = {
  rangeCount: number;
  isCollapsed: boolean;
};

function createFakeDocument({
  activeElement = null,
  selection = null,
}: {
  activeElement?: FakeElement | null;
  selection?: FakeSelection | null;
}) {
  return {
    activeElement,
    getSelection: () => selection,
  };
}

describe('resolveMobileDrawerWidth', () => {
  it('caps the drawer at 80 percent of the viewport width', () => {
    expect(resolveMobileDrawerWidth(320, 390)).toBe(312);
  });
});

describe('shouldIgnoreSidebarSwipeGesture', () => {
  it('ignores gestures that start inside editable text controls', () => {
    const textarea: FakeElement = { tagName: 'textarea' };
    const child: FakeElement = { tagName: 'span', parentElement: textarea };

    expect(shouldIgnoreSidebarSwipeGesture(createFakeDocument({}), child as EventTarget)).toBe(
      true
    );
  });

  it('ignores gestures while page text is selected', () => {
    const target: FakeElement = { tagName: 'div' };

    expect(
      shouldIgnoreSidebarSwipeGesture(
        createFakeDocument({
          selection: {
            rangeCount: 1,
            isCollapsed: false,
          },
        }),
        target as EventTarget
      )
    ).toBe(true);
  });

  it('ignores gestures inside panels that disable sidebar swipe-open', () => {
    const panel: FakeElement = {
      tagName: 'div',
      dataset: { sidebarSwipeOpenDisabled: '' },
    };
    const child: FakeElement = { tagName: 'button', parentElement: panel };

    expect(shouldIgnoreSidebarSwipeGesture(createFakeDocument({}), child as EventTarget)).toBe(
      true
    );
  });
});
