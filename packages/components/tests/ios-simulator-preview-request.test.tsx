// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useIosSimulatorPreviewRequest } from '../src/components/sessions/ios-simulator/use-ios-simulator-preview-request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.stubGlobal('localStorage', window.localStorage);
  vi.stubGlobal('sessionStorage', window.sessionStorage);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function createPreview(persistence: 'tab' | 'device' = 'tab') {
  const node = document.createElement('div');
  document.body.append(node);
  let root = createRoot(node);
  function Harness({
    session,
    request,
    desktop,
  }: {
    session: string;
    request?: string;
    desktop: boolean;
  }) {
    const [open, setOpen] = useState(false);
    useIosSimulatorPreviewRequest(session, request, desktop, () => setOpen(true), persistence);
    return open ? <button onClick={() => setOpen(false)}>Close preview</button> : null;
  }
  return {
    render(session: string, request?: string, desktop = true) {
      act(() => root.render(<Harness session={session} request={request} desktop={desktop} />));
    },
    get open() {
      return node.querySelector('button') !== null;
    },
    close() {
      act(() => node.querySelector('button')!.click());
    },
    remount(restart = false) {
      act(() => root.unmount());
      if (restart) sessionStorage.clear();
      root = createRoot(node);
    },
    dispose() {
      act(() => root.unmount());
      node.remove();
    },
  };
}

it.each(['tab', 'device'] as const)(
  'respects dismissal across switches/remounts and leaves mobile opt-in (%s)',
  (persistence) => {
    const preview = createPreview(persistence);
    try {
      preview.render('a');
      expect(preview.open).toBe(false);
      preview.render('a', 'one', false);
      expect(preview.open).toBe(false);
      preview.render('a', 'one');
      expect(preview.open).toBe(true);
      preview.close();
      preview.render('a', 'one');
      expect(preview.open).toBe(false);
      preview.render('b', 'two');
      expect(preview.open).toBe(true);
      preview.close();
      preview.render('a', 'one');
      expect(preview.open).toBe(false);
      preview.remount();
      preview.render('a', 'one');
      expect(preview.open).toBe(false);
      preview.render('a', 'three');
      expect(preview.open).toBe(true);
    } finally {
      preview.dispose();
    }
  }
);

it('keeps Android closed after restart while allowing new requests and independent iOS discovery', () => {
  const android = createPreview('device');
  const ios = createPreview();
  try {
    android.render('android:a', 'one');
    expect(android.open).toBe(true);
    android.close();
    android.remount(true);
    android.render('android:a', 'one');
    expect(android.open).toBe(false);
    ios.render('a', 'one');
    expect(ios.open).toBe(true);
    android.render('android:a', 'two');
    expect(android.open).toBe(true);
  } finally {
    android.dispose();
    ios.dispose();
  }
});

it('preserves an Android request already consumed by the previous tab-scoped implementation', () => {
  sessionStorage.setItem('lody:simulator-preview-request:android:a', 'one');
  const preview = createPreview('device');
  try {
    preview.render('android:a', 'one');
    expect(preview.open).toBe(false);
    preview.remount(true);
    preview.render('android:a', 'one');
    expect(preview.open).toBe(false);
  } finally {
    preview.dispose();
  }
});

it('falls back to tab consumption when persistent storage cannot be written', () => {
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (this === localStorage) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  const preview = createPreview('device');
  try {
    preview.render('android:a', 'one');
    expect(preview.open).toBe(true);
    preview.close();
    preview.remount();
    preview.render('android:a', 'one');
    expect(preview.open).toBe(false);
    preview.render('android:a', 'two');
    expect(preview.open).toBe(true);
  } finally {
    preview.dispose();
  }
});
