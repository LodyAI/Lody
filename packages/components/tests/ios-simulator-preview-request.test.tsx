// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useIosSimulatorPreviewRequest } from '../src/components/sessions/ios-simulator/use-ios-simulator-preview-request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('opens once per request, preserves dismissal across session switches/remounts, and leaves mobile opt-in', () => {
  sessionStorage.clear();
  const node = document.createElement('div');
  document.body.append(node);
  let root = createRoot(node);
  const open = vi.fn();
  function Harness({
    session,
    request,
    desktop,
  }: {
    session: string;
    request?: string;
    desktop: boolean;
  }) {
    useIosSimulatorPreviewRequest(session, request, desktop, open);
    return null;
  }
  const render = (session: string, request: string | undefined, desktop = true) =>
    act(() => root.render(<Harness session={session} request={request} desktop={desktop} />));
  try {
    render('a', undefined);
    render('a', 'one', false);
    expect(open).not.toHaveBeenCalled();
    render('a', 'one');
    render('a', 'one'); // User dismissed; rerender does not reopen it.
    expect(open).toHaveBeenCalledTimes(1);
    render('b', 'two');
    render('a', 'one');
    expect(open).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    root = createRoot(node);
    render('a', 'one');
    expect(open).toHaveBeenCalledTimes(2);
    render('a', 'three');
    expect(open).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    node.remove();
    sessionStorage.clear();
  }
});
