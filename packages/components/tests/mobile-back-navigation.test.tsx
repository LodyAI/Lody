// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MobileDrillPageLayout,
  useMobileBackRevealClass,
} from '../src/components/mobile/mobile-drill-page-layout';
import { Drawer, DrawerContent, DrawerTitle } from '../src/ui/drawer';
import { Dialog } from '../src/ui/dialog';
import { consumeMobileBackNavigation, dispatchMobileBack } from '../src/lib/mobile-back-navigation';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function DestinationPage() {
  const revealClass = useMobileBackRevealClass();
  return (
    <div data-destination-page="" className={revealClass ?? 'mobile-drill-in'}>
      Home
    </div>
  );
}

function DrillStackHarness() {
  const [page, setPage] = useState<'detail' | 'home'>('detail');
  if (page === 'home') return <DestinationPage />;
  return (
    <MobileDrillPageLayout onBack={() => setPage('home')}>
      <div>Detail</div>
    </MobileDrillPageLayout>
  );
}

function NestedSurfacesHarness({ onPageBack }: { onPageBack: () => void }) {
  const [outerOpen, setOuterOpen] = useState(true);
  const [innerOpen, setInnerOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);

  return (
    <MobileDrillPageLayout onBack={onPageBack}>
      <div
        data-state-summary={`${outerOpen ? 'outer' : ''}:${innerOpen ? 'inner' : ''}:${dialogOpen ? 'dialog' : ''}`}
      />
      <Drawer open={outerOpen} onOpenChange={setOuterOpen} direction="right">
        <DrawerContent>
          <DrawerTitle visuallyHidden>Outer</DrawerTitle>
          <Drawer open={innerOpen} onOpenChange={setInnerOpen} direction="right">
            <DrawerContent>
              <DrawerTitle visuallyHidden>Inner</DrawerTitle>
              <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
                <Dialog.Content>
                  <Dialog.Title>Confirm</Dialog.Title>
                </Dialog.Content>
              </Dialog.Root>
            </DrawerContent>
          </Drawer>
        </DrawerContent>
      </Drawer>
    </MobileDrillPageLayout>
  );
}

describe('mobile back navigation stack', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    consumeMobileBackNavigation();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await vi.runOnlyPendingTimersAsync();
    });
    consumeMobileBackNavigation();
    container.remove();
    vi.useRealTimers();
  });

  it('slides a drill page off to the right and reveals the destination instead of pushing it right-to-left', async () => {
    await act(async () => {
      root.render(<DrillStackHarness />);
    });

    const animateSpy = vi.fn();
    Element.prototype.animate = animateSpy;

    let handled = false;
    await act(async () => {
      handled = dispatchMobileBack();
    });

    expect(handled).toBe(true);
    const exitClonePanel = document.body.querySelector('.mobile-drill-out');
    expect(exitClonePanel).not.toBeNull();
    expect(animateSpy).toHaveBeenCalledWith(
      [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(100%, 0, 0)' }],
      expect.objectContaining({ duration: 280, fill: 'forwards' })
    );

    const destination = container.querySelector('[data-destination-page]');
    expect(destination?.className).toBe('mobile-drill-reveal');

    await act(async () => {
      vi.advanceTimersByTime(280);
    });
    expect(document.body.querySelector('.mobile-drill-out')).toBeNull();
  });

  it('dismisses simultaneously mounted modal, nested drawer, outer drawer, and drill page in visual top-down order', async () => {
    const onPageBack = vi.fn();
    await act(async () => {
      root.render(<NestedSurfacesHarness onPageBack={onPageBack} />);
    });

    const summary = () =>
      container.querySelector('[data-state-summary]')?.getAttribute('data-state-summary');
    expect(summary()).toBe('outer:inner:dialog');

    await act(async () => {
      expect(dispatchMobileBack()).toBe(true);
    });
    expect(summary()).toBe('outer:inner:');
    expect(onPageBack).not.toHaveBeenCalled();

    await act(async () => {
      expect(dispatchMobileBack()).toBe(true);
    });
    expect(summary()).toBe('outer::');
    expect(onPageBack).not.toHaveBeenCalled();

    await act(async () => {
      expect(dispatchMobileBack()).toBe(true);
    });
    expect(summary()).toBe('::');
    expect(onPageBack).not.toHaveBeenCalled();

    await act(async () => {
      expect(dispatchMobileBack()).toBe(true);
    });
    expect(onPageBack).toHaveBeenCalledTimes(1);
  });
});
