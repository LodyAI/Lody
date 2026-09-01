import { describe, expect, it } from 'vitest';

import {
  getMobileMainLayoutRootClassName,
  getWebWorkspaceLayoutRootClassName,
} from '../src/components/workspace-layout-utils';

/**
 * The iPad native shell renders the desktop/web workspace layout (viewport
 * width >= 768) with `viewport-fit=cover`, so its root has to reserve the
 * iPadOS status-bar inset or the sidebar header and session chrome share their
 * first row with the system clock and status icons.
 */
describe('web workspace layout root safe area', () => {
  for (const [label, className] of [
    ['workspace route', getWebWorkspaceLayoutRootClassName()],
    ['settings route', getWebWorkspaceLayoutRootClassName({ settingsRoute: true })],
  ] as const) {
    describe(label, () => {
      it('reserves the top and side safe areas', () => {
        expect(className).toContain('pt-[var(--safe-area-top)]');
        expect(className).toContain('pl-[var(--safe-area-left)]');
        expect(className).toContain('pr-[var(--safe-area-right)]');
      });

      it('leaves the bottom safe area to the surface that sits against it', () => {
        // The composer shell already pads itself by `env(safe-area-inset-bottom)`;
        // a root inset would double it.
        expect(className).not.toContain('safe-area-bottom');
        expect(className).not.toContain('safe-area-inset-bottom');
      });

      it('keeps the native keyboard offset', () => {
        expect(className).toContain('pb-[var(--native-keyboard-height)]');
      });

      it('still fills the viewport and paints the app background behind the insets', () => {
        expect(className).toContain('h-svh');
        expect(className).toContain('bg-background');
      });
    });
  }

  it('positions the settings root for its window drag strip', () => {
    expect(getWebWorkspaceLayoutRootClassName({ settingsRoute: true }).split(' ')).toContain(
      'relative'
    );
    expect(getWebWorkspaceLayoutRootClassName().split(' ')).not.toContain('relative');
  });
});

describe('mobile workspace layout root safe area', () => {
  it('keeps insetting per surface rather than at the root', () => {
    const className = getMobileMainLayoutRootClassName();
    expect(className).not.toContain('safe-area-top');
    expect(className).not.toContain('safe-area-left');
    expect(className).not.toContain('safe-area-right');
    expect(className).toContain('pb-[var(--native-keyboard-height)]');
  });
});
