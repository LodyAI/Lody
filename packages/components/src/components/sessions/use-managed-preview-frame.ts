import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { SessionId } from '@lody/shared';
import {
  MANAGED_BROWSER_COMMAND_MESSAGE_TYPE,
  MANAGED_BROWSER_DOCUMENT_UNLOAD_MESSAGE_TYPE,
  MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
  MANAGED_BROWSER_READY_MESSAGE_TYPE,
  MANAGED_BROWSER_STATE_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  type ManagedBrowserCommand,
  type ManagedBrowserNavigationRequestMessage,
  type ManagedBrowserStateMessage,
} from '@lody/shared/visual-annotation-types';

import { useStableCallback } from '@/hooks/use-stable-callback';
import { buildManagedViewerUrlForLogicalUrl, toManagedLogicalUrl } from '@/lib/session-browser-url';
import {
  acquireManagedPreviewFrame,
  releaseManagedPreviewFrame,
} from './managed-preview-frame-cache';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isManagedBrowserStateMessage = (value: unknown): value is ManagedBrowserStateMessage =>
  isRecord(value) &&
  value.type === MANAGED_BROWSER_STATE_MESSAGE_TYPE &&
  isRecord(value.payload) &&
  typeof value.payload.url === 'string' &&
  typeof value.payload.title === 'string' &&
  typeof value.payload.loading === 'boolean' &&
  typeof value.payload.canGoBack === 'boolean' &&
  typeof value.payload.canGoForward === 'boolean';

const isManagedBrowserNavigationRequestMessage = (
  value: unknown
): value is ManagedBrowserNavigationRequestMessage =>
  isRecord(value) &&
  value.type === MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE &&
  isRecord(value.payload) &&
  typeof value.payload.url === 'string';

export type ManagedPreviewFrameOptions = {
  hostRef: RefObject<HTMLDivElement | null>;
  /** Cache key for application previews. Static documents are never cached. */
  sessionId: SessionId | null;
  viewerUrl: string;
  logicalUrl: string;
  /** A policy-owned static document (`buildStaticHtmlPreviewDocument`). */
  documentHtml?: string;
  /**
   * The user explicitly chose to run this document's scripts. Required on engines
   * where `getExecutableHtmlPreviewSupport()` is `opt-in`; the frame cache refuses
   * to create an executable static frame there without it.
   */
  scriptsOptedIn?: boolean;
  title: string;
  annotationEnabled: boolean;
  command?: { id: number; action: ManagedBrowserCommand };
  invalidRuntimeUrlMessage: string;
  onAnnotationAvailabilityChange: (available: boolean) => void;
  onRuntimeError: (error: string | null) => void;
  onLoadingChange: (loading: boolean) => void;
  onBrowserStateChange: (state: ManagedBrowserStateMessage['payload']) => void;
  onNavigationRequest: (url: string) => void;
  /** Runtime messages other than ready, state, and navigation requests. */
  onRuntimeMessage?: (data: unknown) => void;
};

/**
 * The one owner of a managed preview iframe: frame policy and lifecycle (via the
 * frame cache), the runtime handshake, browser state, parent-owned reload, and
 * the navigation policy. Every surface that runs preview JavaScript goes through
 * this hook so a security fix lands in exactly one place.
 */
export function useManagedPreviewFrame({
  hostRef,
  sessionId,
  viewerUrl,
  logicalUrl,
  documentHtml,
  scriptsOptedIn = false,
  title,
  annotationEnabled,
  command,
  invalidRuntimeUrlMessage,
  onAnnotationAvailabilityChange,
  onRuntimeError,
  onLoadingChange,
  onBrowserStateChange,
  onNavigationRequest,
  onRuntimeMessage,
}: ManagedPreviewFrameOptions) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const handledCommandIdRef = useRef(0);
  // Lifecycle of a static srcdoc, used to detect page script replacing it
  // (for example `location.assign`), which the runtime cannot cancel:
  // - `pending`: before the runtime announces itself. Loads here (an engine's
  //   initial about:blank, or a document without a live runtime) are ordinary.
  // - `reloading`: the parent replaced the srcdoc; the outgoing runtime's one
  //   unload signal is expected.
  // - `ready` → `loaded`: the runtime is live, then the document loaded. An unload
  //   signal from either, or any load after `loaded`, is a replacement.
  // - `retired`: the frame was removed after a replacement. Reload re-acquires a
  //   fresh frame (bumping `frameGeneration`) instead of the detached one.
  const staticPhaseRef = useRef<'pending' | 'reloading' | 'ready' | 'loaded' | 'retired'>(
    'pending'
  );
  const [frameGeneration, setFrameGeneration] = useState(0);
  const previewOrigin = useMemo(
    () => (documentHtml === undefined ? new URL(viewerUrl).origin : 'null'),
    [documentHtml, viewerUrl]
  );
  const previewPostMessageOrigin = documentHtml === undefined ? previewOrigin : '*';
  // Read at acquire time so a language switch retitles the live frame instead of
  // re-running the acquire effect, which would reparent the iframe.
  const titleRef = useRef(title);

  const postToPreview = useCallback(
    (message: unknown) => {
      if (!iframeLoaded) return;
      iframeRef.current?.contentWindow?.postMessage(message, previewPostMessageOrigin);
    },
    [iframeLoaded, previewPostMessageOrigin]
  );

  const mapRuntimeUrl = useCallback(
    (url: string): string =>
      documentHtml === undefined ? toManagedLogicalUrl(url, logicalUrl) : logicalUrl,
    [documentHtml, logicalUrl]
  );

  // Page script replaced the policy-owned srcdoc. Remove the frame at once so the
  // replacement page cannot be used, then leave rendered mode via the navigation
  // policy. Callers normally unmount on that request; if one does not, reload
  // re-acquires a fresh frame.
  const retireReplacedStaticFrame = useStableCallback(() => {
    if (staticPhaseRef.current === 'retired') return;
    staticPhaseRef.current = 'retired';
    iframeRef.current?.remove();
    setIframeLoaded(false);
    onAnnotationAvailabilityChange(false);
    onLoadingChange(false);
    onNavigationRequest(logicalUrl);
  });

  const handleIframeLoad = useStableCallback(() => {
    if (documentHtml !== undefined) {
      const phase = staticPhaseRef.current;
      if (phase === 'retired') return;
      if (phase === 'loaded') {
        // Fallback for a replacement the runtime could not report on unload.
        retireReplacedStaticFrame();
        return;
      }
      if (phase === 'ready') staticPhaseRef.current = 'loaded';
    }
    // A new document starts its handshake from scratch; a live runtime re-reports
    // immediately in response to the SET_ANNOTATION_MODE message below.
    setIframeLoaded(true);
    onAnnotationAvailabilityChange(false);
    onLoadingChange(false);
    // Annotation is optional. A missing or late handshake must not turn page
    // loading into an error; a later valid state message enables annotation.
    iframeRef.current?.contentWindow?.postMessage(
      { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: annotationEnabled },
      previewPostMessageOrigin
    );
  });

  const syncFrameLoadState = useStableCallback((loaded: boolean) => {
    setIframeLoaded(loaded);
    onLoadingChange(!loaded);
  });

  const hardReloadFrame = useStableCallback(() => {
    const iframe = iframeRef.current;
    if (documentHtml !== undefined) {
      if (staticPhaseRef.current === 'retired') {
        syncFrameLoadState(false);
        setFrameGeneration((generation) => generation + 1);
        return;
      }
      if (!iframe) return;
      syncFrameLoadState(false);
      staticPhaseRef.current = 'reloading';
      iframe.srcdoc = documentHtml;
      return;
    }
    if (!iframe) return;
    let nextSrc = viewerUrl;
    try {
      nextSrc = buildManagedViewerUrlForLogicalUrl(viewerUrl, logicalUrl);
    } catch {
      // Fall back to the acquire-time viewer URL when the logical URL is unusable.
    }
    syncFrameLoadState(false);
    iframe.src = nextSrc;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    staticPhaseRef.current = 'pending';
    const frame = acquireManagedPreviewFrame({
      sessionId,
      viewerUrl,
      title: titleRef.current,
      host,
      documentHtml,
      scriptsOptedIn,
    });
    iframeRef.current = frame.iframe;
    frame.iframe.addEventListener('load', handleIframeLoad);
    syncFrameLoadState(frame.loaded);
    return () => {
      frame.iframe.removeEventListener('load', handleIframeLoad);
      if (iframeRef.current === frame.iframe) iframeRef.current = null;
      releaseManagedPreviewFrame(documentHtml === undefined ? sessionId : null, frame.iframe);
    };
  }, [
    documentHtml,
    frameGeneration,
    handleIframeLoad,
    hostRef,
    scriptsOptedIn,
    sessionId,
    syncFrameLoadState,
    viewerUrl,
  ]);

  useEffect(() => {
    titleRef.current = title;
    const iframe = iframeRef.current;
    if (iframe) iframe.title = title;
  }, [title]);

  useEffect(() => {
    onAnnotationAvailabilityChange(false);
    onRuntimeError(null);
  }, [documentHtml, onAnnotationAvailabilityChange, onRuntimeError, sessionId, viewerUrl]);

  useEffect(() => {
    if (iframeLoaded) {
      postToPreview({ type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: annotationEnabled });
    }
  }, [annotationEnabled, iframeLoaded, postToPreview]);

  useEffect(() => {
    if (!command || command.id === handledCommandIdRef.current) return;
    if (command.action === 'reload') {
      // Always reload from the parent: a runtime that once handshook can later
      // fail or be removed by the page, so it cannot own this recovery action.
      handledCommandIdRef.current = command.id;
      hardReloadFrame();
      return;
    }
    if (!iframeLoaded) return;
    handledCommandIdRef.current = command.id;
    postToPreview({
      type: MANAGED_BROWSER_COMMAND_MESSAGE_TYPE,
      command: command.action,
    });
  }, [command, documentHtml, hardReloadFrame, iframeLoaded, postToPreview]);

  const handleRuntimeMessage = useStableCallback((data: unknown) => onRuntimeMessage?.(data));

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== previewOrigin || event.source !== iframeRef.current?.contentWindow)
        return;
      const type = isRecord(event.data) ? event.data.type : undefined;
      if (type === MANAGED_BROWSER_READY_MESSAGE_TYPE) {
        if (
          documentHtml !== undefined &&
          (staticPhaseRef.current === 'pending' || staticPhaseRef.current === 'reloading')
        ) {
          staticPhaseRef.current = 'ready';
        }
        // Scripts can be ready while images or other page resources still load.
        // This reply does not require iframeLoaded and contains no page data.
        iframeRef.current?.contentWindow?.postMessage(
          { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: annotationEnabled },
          previewPostMessageOrigin
        );
      } else if (type === MANAGED_BROWSER_DOCUMENT_UNLOAD_MESSAGE_TYPE) {
        // Only static documents send this, and never with page data. Unlike the
        // load fallback it does not wait for the replacement page to finish
        // loading, and it also covers a replacement before the srcdoc's own load.
        if (documentHtml === undefined) return;
        if (staticPhaseRef.current === 'reloading') {
          staticPhaseRef.current = 'pending';
          return;
        }
        retireReplacedStaticFrame();
      } else if (isManagedBrowserStateMessage(event.data)) {
        let mappedUrl: string;
        try {
          mappedUrl = mapRuntimeUrl(event.data.payload.url);
        } catch {
          onAnnotationAvailabilityChange(false);
          onRuntimeError(invalidRuntimeUrlMessage);
          return;
        }
        onAnnotationAvailabilityChange(true);
        onRuntimeError(null);
        // In-frame navigation does not change the parent's iframe src. Use the
        // runtime as an optional toolbar hint, never as frame/content readiness.
        // The native load handler clears this even if the runtime disappears.
        onLoadingChange(event.data.payload.loading);
        onBrowserStateChange({
          ...event.data.payload,
          url: mappedUrl,
        });
      } else if (isManagedBrowserNavigationRequestMessage(event.data)) {
        onNavigationRequest(event.data.payload.url);
      } else {
        handleRuntimeMessage(event.data);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    annotationEnabled,
    documentHtml,
    handleRuntimeMessage,
    invalidRuntimeUrlMessage,
    mapRuntimeUrl,
    onAnnotationAvailabilityChange,
    onBrowserStateChange,
    onLoadingChange,
    onNavigationRequest,
    onRuntimeError,
    previewOrigin,
    previewPostMessageOrigin,
    retireReplacedStaticFrame,
  ]);

  return { iframeRef, iframeLoaded, postToPreview, mapRuntimeUrl };
}
