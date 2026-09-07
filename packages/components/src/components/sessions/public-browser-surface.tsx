import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Globe2, Loader2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ElectronPublicBrowserBounds, ElectronPublicBrowserState } from '@lody/shared';

import { isElectronRenderer } from '@/lib/electron';
import { getPublicBrowserBridge } from '@/lib/electron-ipc-client';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';

type PublicBrowserSurfaceProps = {
  browserId: string;
  url: string;
  navigationRequestId: number | null;
  active: boolean;
  className?: string;
  onStateChange: (state: ElectronPublicBrowserState) => void;
};

const readBounds = (element: HTMLElement): ElectronPublicBrowserBounds | null => {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
};

const formatBridgeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function PublicBrowserSurface({
  browserId,
  url,
  navigationRequestId,
  active,
  className,
  onStateChange,
}: PublicBrowserSurfaceProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const layoutGenerationRef = useRef(0);
  const navigationRef = useRef<{ requestId: number; url: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ElectronPublicBrowserState['phase']>('idle');
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [blockingOverlayOpen, setBlockingOverlayOpen] = useState(false);
  const bridge =
    typeof window === 'undefined' ? undefined : (getPublicBrowserBridge() ?? undefined);
  const electron = isElectronRenderer();
  const nativeViewVisible = active && !blockingOverlayOpen;

  useEffect(() => {
    if (!electron) return undefined;
    const update = () => {
      setBlockingOverlayOpen(
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        ) !== null
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-state', 'role'],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [electron]);

  useEffect(() => {
    if (!electron) return undefined;
    if (!bridge || bridge.capability !== 'web-contents-view-v1') {
      setLocalError(
        t(
          'sessions.browser.errors.desktopEngineMissing',
          'The desktop public browser engine is unavailable in this app build.'
        )
      );
      return undefined;
    }
    return bridge.onState((state) => {
      if (state.browserId !== browserId) return;
      setPhase(state.phase);
      setLocalError(state.error ?? null);
      void bridge.setVisible(browserId, nativeViewVisible && !state.error).then(
        (result) => {
          if (!result.ok) setLocalError(result.error);
        },
        (error: unknown) => setLocalError(formatBridgeError(error))
      );
      onStateChange(state);
    });
  }, [bridge, browserId, electron, nativeViewVisible, onStateChange, t]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!electron || !bridge || !host) return undefined;
    const generation = ++layoutGenerationRef.current;
    let cancelled = false;
    setSurfaceReady(false);

    const syncBounds = async () => {
      try {
        const bounds = readBounds(host);
        if (!bounds || cancelled) return;
        const result = createdRef.current
          ? await bridge.setBounds(browserId, bounds)
          : await bridge.create(browserId, bounds);
        if (cancelled) {
          if (layoutGenerationRef.current === generation && result.ok) {
            await bridge.setVisible(browserId, false);
          }
          return;
        }
        if (!result.ok) {
          setLocalError(result.error);
          return;
        }
        createdRef.current = true;
        setSurfaceReady(true);
        setPhase(result.state.phase);
        onStateChange(result.state);
        const visibility = await bridge.setVisible(
          browserId,
          nativeViewVisible && !result.state.error
        );
        if (!visibility.ok) setLocalError(visibility.error);
      } catch (error) {
        if (!cancelled) setLocalError(formatBridgeError(error));
      }
    };

    void syncBounds();
    const stopObserving = observeResizeOnAnimationFrame(host, () => {
      void syncBounds();
    });
    const handleWindowLayout = () => void syncBounds();
    window.addEventListener('scroll', handleWindowLayout, true);
    window.addEventListener('resize', handleWindowLayout);
    return () => {
      cancelled = true;
      stopObserving();
      window.removeEventListener('scroll', handleWindowLayout, true);
      window.removeEventListener('resize', handleWindowLayout);
      if (createdRef.current) {
        void bridge.setVisible(browserId, false).catch((error: unknown) => {
          console.error('Failed to hide public browser surface', error);
        });
      }
    };
  }, [bridge, browserId, electron, nativeViewVisible, onStateChange]);

  /* Re-issue the visibility IPC only when the TARGET changes. This effect
     writes `localError` and also depends on it (an error hides the native
     view), so an unconditional call retried on every distinct failure
     message — a bridge error carrying any varying detail (id, path,
     timestamp) became an unbounded setVisible/render spin. A failed attempt
     records the error and waits for the next real visibility change instead
     of retrying itself. */
  const lastRequestedVisibilityRef = useRef<{ browserId: string; visible: boolean } | null>(null);
  useEffect(() => {
    if (!electron || !bridge || !createdRef.current) return;
    const targetVisible = nativeViewVisible && !localError;
    const last = lastRequestedVisibilityRef.current;
    if (last && last.browserId === browserId && last.visible === targetVisible) return;
    lastRequestedVisibilityRef.current = { browserId, visible: targetVisible };
    void bridge.setVisible(browserId, targetVisible).then(
      (result) => {
        if (!result.ok) setLocalError(result.error);
      },
      (error: unknown) => setLocalError(formatBridgeError(error))
    );
  }, [bridge, browserId, electron, localError, nativeViewVisible]);

  useEffect(() => {
    if (!electron || !bridge || !surfaceReady || !url || navigationRequestId === null) return;
    if (
      navigationRef.current?.requestId === navigationRequestId &&
      navigationRef.current.url === url
    ) {
      return;
    }
    navigationRef.current = { requestId: navigationRequestId, url };
    setPhase('loading');
    setLocalError(null);
    void bridge.navigate(browserId, url).then(
      (result) => {
        if (!result.ok) {
          setPhase('error');
          setLocalError(result.error);
        }
      },
      (error: unknown) => {
        setPhase('error');
        setLocalError(formatBridgeError(error));
      }
    );
  }, [bridge, browserId, electron, navigationRequestId, surfaceReady, url]);

  if (!electron) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-center',
          className
        )}
      >
        <div className="max-w-sm">
          <ShieldAlert className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t(
              'sessions.browser.errors.desktopOnly',
              'Only the desktop app can browse arbitrary URLs.'
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className={cn('relative min-h-0 flex-1 overflow-hidden bg-white', className)}
      data-public-browser-surface
    >
      {phase === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {localError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
          <div className="max-w-sm">
            <Globe2 className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {t('sessions.browser.errors.navigationFailed', 'Page could not be opened')}
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{localError}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
