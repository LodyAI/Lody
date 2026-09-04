import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import {
  type SessionMeta,
  type VisualAnnotationReferencePayload,
} from '@lody/shared';
import {
  createMinimalVisualAnnotationAnchor,
  type VisualAnnotationInspectPayload,
} from '@lody/shared/visual-annotation-inspector';
import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  MANAGED_BROWSER_COMMAND_MESSAGE_TYPE,
  MANAGED_BROWSER_NAVIGATION_REQUEST_MESSAGE_TYPE,
  MANAGED_BROWSER_STATE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
  type VisualAnnotationAnchorsResolvedMessage,
  type VisualAnnotationRect,
  type VisualAnnotationRectRatio,
  type VisualAnnotationResolvedAnchor,
  type VisualAnnotationTargetMessage,
  type VisualAnnotationViewport,
  type ResolveVisualAnnotationAnchorsMessage,
  type ManagedBrowserCommand,
  type ManagedBrowserNavigationRequestMessage,
  type ManagedBrowserStateMessage,
} from '@lody/shared/visual-annotation-types';
import {
  createVisualAnnotationReferenceFromPreviewComment,
  type PreviewVisualComment,
} from '@lody/shared/preview-comment-types';

import { userAtom } from '@/atoms';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { toast } from 'sonner';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { getVisiblePreviewVisualComments } from '@/components/preview/preview-visual-comments';
import {
  EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS,
  getVisualAnnotationReferenceKey,
} from '@/components/chat/visual-annotation-reference-state';
import { usePreviewVisualCommentDoc } from '@/hooks/use-preview-visual-comment-doc';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useActiveAssistantTurnId } from '@/hooks/use-session-turn-selectors';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  buildManagedViewerUrlForLogicalUrl,
  getManagedPageKey,
  toManagedLogicalUrl,
} from '@/lib/session-browser-url';
import { cn } from '@/lib/utils';
import {
  acquireManagedPreviewFrame,
  releaseManagedPreviewFrame,
} from './managed-preview-frame-cache';

type ManagedPreviewSurfaceProps = {
  session: SessionMeta;
  viewerUrl: string;
  annotationEnabled: boolean;
  logicalUrl: string;
  command?: { id: number; action: ManagedBrowserCommand };
  className?: string;
  documentHtml?: string;
  visualAnnotationReferenceKeys?: readonly string[];
  onAnnotationAvailabilityChange: (available: boolean) => void;
  onRuntimeError: (error: string | null) => void;
  onLoadingChange: (loading: boolean) => void;
  onBrowserStateChange: (state: ManagedBrowserStateMessage['payload']) => void;
  onNavigationRequest: (url: string) => void;
  onAddVisualAnnotationToChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
  onToggleVisualAnnotationInChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
const hasOptionalStringFields = (record: Record<string, unknown>, fields: string[]): boolean =>
  fields.every((field) => isOptionalString(record[field]));

const isVisualAnnotationRect = (value: unknown): value is VisualAnnotationRect =>
  isRecord(value) &&
  ['x', 'y', 'width', 'height', 'top', 'left', 'right', 'bottom'].every((field) =>
    isFiniteNumber(value[field])
  );
const isVisualAnnotationRectRatio = (value: unknown): value is VisualAnnotationRectRatio =>
  isRecord(value) && ['x', 'y', 'width', 'height'].every((field) => isFiniteNumber(value[field]));
const isVisualAnnotationViewport = (value: unknown): value is VisualAnnotationViewport =>
  isRecord(value) &&
  ['width', 'height', 'scrollX', 'scrollY', 'devicePixelRatio'].every((field) =>
    isFiniteNumber(value[field])
  );
const isVisualAnnotationClick = (
  value: unknown
): value is VisualAnnotationInspectPayload['click'] =>
  isRecord(value) &&
  ['clientX', 'clientY', 'pageX', 'pageY'].every((field) => isFiniteNumber(value[field]));
const isVisualAnnotationAncestor = (
  value: unknown
): value is VisualAnnotationInspectPayload['ancestors'][number] =>
  isRecord(value) &&
  typeof value.tag === 'string' &&
  typeof value.selector === 'string' &&
  isStringRecord(value.attributes) &&
  hasOptionalStringFields(value, ['id', 'className', 'role', 'text']);
const isVisualAnnotationNearbyText = (
  value: unknown
): value is VisualAnnotationInspectPayload['nearbyText'] =>
  isRecord(value) &&
  hasOptionalStringFields(value, ['self', 'parentSummary']) &&
  (value.siblingTexts === undefined ||
    (Array.isArray(value.siblingTexts) &&
      value.siblingTexts.every((item) => typeof item === 'string')));

const isVisualAnnotationInspectPayload = (
  value: unknown
): value is VisualAnnotationInspectPayload => {
  if (!isRecord(value) || !isRecord(value.page) || !isRecord(value.target)) return false;
  return (
    typeof value.page.url === 'string' &&
    typeof value.page.pathname === 'string' &&
    typeof value.page.title === 'string' &&
    isVisualAnnotationViewport(value.page.viewport) &&
    isVisualAnnotationClick(value.click) &&
    typeof value.target.tag === 'string' &&
    isStringRecord(value.target.attributes) &&
    isVisualAnnotationRect(value.target.rect) &&
    typeof value.target.selector === 'string' &&
    typeof value.target.xpath === 'string' &&
    typeof value.target.outerHTMLPreview === 'string' &&
    hasOptionalStringFields(value.target, ['id', 'className', 'role', 'text']) &&
    Array.isArray(value.ancestors) &&
    value.ancestors.every(isVisualAnnotationAncestor) &&
    isVisualAnnotationNearbyText(value.nearbyText) &&
    isStringRecord(value.style)
  );
};

const isVisualAnnotationResolvedAnchor = (
  value: unknown
): value is VisualAnnotationResolvedAnchor =>
  isRecord(value) &&
  typeof value.commentId === 'string' &&
  typeof value.resolved === 'boolean' &&
  (value.rect === undefined || isVisualAnnotationRect(value.rect)) &&
  (value.rectRatio === undefined || isVisualAnnotationRectRatio(value.rectRatio)) &&
  hasOptionalStringFields(value, ['selector', 'xpath']);

const isVisualAnnotationTargetMessage = (value: unknown): value is VisualAnnotationTargetMessage =>
  isRecord(value) &&
  value.type === VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE &&
  isVisualAnnotationInspectPayload(value.payload);

const isVisualAnnotationAnchorsResolvedMessage = (
  value: unknown
): value is VisualAnnotationAnchorsResolvedMessage =>
  isRecord(value) &&
  value.type === VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE &&
  isRecord(value.payload) &&
  isVisualAnnotationViewport(value.payload.viewport) &&
  Array.isArray(value.payload.results) &&
  value.payload.results.every(isVisualAnnotationResolvedAnchor);

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

const getTargetLabel = (payload: VisualAnnotationInspectPayload): string => {
  const tag = payload.target.tag.toLowerCase();
  const id = payload.target.id ? `#${payload.target.id}` : '';
  const text = payload.target.text?.trim();
  return text ? `${tag}${id} "${text.slice(0, 80)}"` : `${tag}${id}`;
};

const clamp = (value: number, min: number, max: number): number =>
  max < min ? min : Math.min(Math.max(value, min), max);
const round = (value: number): number => Math.round(value * 100) / 100;

const DRAFT_VISUAL_ANNOTATION_ANCHOR_ID = '__lody_visual_annotation_draft__';

type TrackedVisualAnnotationAnchor =
  ResolveVisualAnnotationAnchorsMessage['payload']['anchors'][number];

const isResolvedAnchorVisible = (
  resolvedAnchor: VisualAnnotationResolvedAnchor | undefined,
  viewport: { width: number; height: number }
): boolean => {
  if (!resolvedAnchor) return true;
  if (!resolvedAnchor.resolved) return false;
  const rect = resolvedAnchor.rect;
  if (!rect) return true;
  return (
    rect.right > 0 && rect.bottom > 0 && rect.left < viewport.width && rect.top < viewport.height
  );
};

const getDraftPosition = (
  payload: VisualAnnotationInspectPayload,
  viewport: { width: number; height: number },
  resolvedAnchor?: VisualAnnotationResolvedAnchor
): { left: number; top: number } => {
  if (resolvedAnchor?.resolved && resolvedAnchor.rectRatio) {
    const rect = resolvedAnchor.rectRatio;
    return {
      left: round(
        clamp(
          rect.x * viewport.width + Math.min(rect.width * viewport.width, 24),
          12,
          Math.max(12, viewport.width - 292)
        )
      ),
      top: round(
        clamp(
          (rect.y + rect.height) * viewport.height + 12,
          12,
          Math.max(12, viewport.height - 220)
        )
      ),
    };
  }
  const clickViewport = payload.page.viewport;
  const scaleX = clickViewport.width > 0 ? viewport.width / clickViewport.width : 1;
  const scaleY = clickViewport.height > 0 ? viewport.height / clickViewport.height : 1;
  return {
    left: round(
      clamp(
        payload.target.rect.left * scaleX + Math.min(payload.target.rect.width * scaleX, 24),
        12,
        Math.max(12, viewport.width - 292)
      )
    ),
    top: round(
      clamp(payload.target.rect.bottom * scaleY + 12, 12, Math.max(12, viewport.height - 220))
    ),
  };
};

export function ManagedPreviewSurface({
  session,
  viewerUrl,
  annotationEnabled,
  logicalUrl,
  command,
  className,
  documentHtml,
  visualAnnotationReferenceKeys = EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS,
  onAnnotationAvailabilityChange,
  onRuntimeError,
  onLoadingChange,
  onBrowserStateChange,
  onNavigationRequest,
  onAddVisualAnnotationToChat,
  onToggleVisualAnnotationInChat,
}: ManagedPreviewSurfaceProps) {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const sessionDoc = useSessionDoc(session.id);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeHostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [selectedTarget, setSelectedTarget] = useState<VisualAnnotationInspectPayload | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<string[]>([]);
  const [resolvedAnchors, setResolvedAnchors] = useState<
    Record<string, VisualAnnotationResolvedAnchor>
  >({});
  const trackedAnchorIdsRef = useRef<ReadonlySet<string>>(new Set());
  const runtimeHandshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the CURRENT document's injected runtime has reported in. Browser
  // commands are delivered by postMessage to that runtime, so without it (proxy
  // error page, CSP-blocked script, non-injected document) they land nowhere.
  const runtimeAliveRef = useRef(false);
  const handledCommandIdRef = useRef(0);
  const previewOrigin = useMemo(
    () => (documentHtml === undefined ? new URL(viewerUrl).origin : 'null'),
    [documentHtml, viewerUrl]
  );
  const previewPostMessageOrigin = documentHtml === undefined ? previewOrigin : '*';
  const managedFrameTitle = t('sessions.browser.managedFrameTitle', 'Managed preview');
  // Read at acquire time so a language switch retitles the live frame instead of
  // re-running the acquire effect, which would reparent the iframe.
  const managedFrameTitleRef = useRef(managedFrameTitle);
  const commentUser = useMemo(
    () => (user?.id ? { id: user.id, name: user.name ?? user.email ?? undefined } : null),
    [user?.email, user?.id, user?.name]
  );
  const commentDoc = usePreviewVisualCommentDoc(session.id, {
    enabled: true,
    currentUser: commentUser,
  });
  const currentPageKey = useMemo(() => getManagedPageKey(logicalUrl, logicalUrl), [logicalUrl]);
  const comments = useMemo(
    () =>
      getVisiblePreviewVisualComments(commentDoc.comments).filter(
        (comment) => getManagedPageKey(comment.anchor.page.url, logicalUrl) === currentPageKey
      ),
    [commentDoc.comments, currentPageKey, logicalUrl]
  );
  const visibleCommentIds = useMemo(
    () => new Set(comments.map((comment) => comment.id)),
    [comments]
  );
  const stagedCommentIds = useMemo(() => {
    const keys = new Set(visualAnnotationReferenceKeys);
    return comments
      .filter((comment) =>
        keys.has(
          getVisualAnnotationReferenceKey(
            createVisualAnnotationReferenceFromPreviewComment(comment)
          )
        )
      )
      .map((comment) => comment.id);
  }, [comments, visualAnnotationReferenceKeys]);
  const activeAssistantTurnId = useActiveAssistantTurnId(sessionDoc);
  const commentTurnId = activeAssistantTurnId ?? session.latestUserMsgId ?? session.id;

  const trackedAnchors = useMemo<TrackedVisualAnnotationAnchor[]>(() => {
    const next = comments.map((comment) => ({
      commentId: comment.id,
      anchor: comment.anchor,
    }));
    if (selectedTarget) {
      next.push({
        commentId: DRAFT_VISUAL_ANNOTATION_ANCHOR_ID,
        anchor: createMinimalVisualAnnotationAnchor(selectedTarget),
      });
    }
    return next;
  }, [comments, selectedTarget]);

  const postToPreview = useCallback(
    (message: unknown) => {
      if (!iframeLoaded) return;
      iframeRef.current?.contentWindow?.postMessage(message, previewPostMessageOrigin);
    },
    [iframeLoaded, previewPostMessageOrigin]
  );

  const postTrackedAnchors = useCallback(
    (anchors: readonly TrackedVisualAnnotationAnchor[]) => {
      trackedAnchorIdsRef.current = new Set(anchors.map(({ commentId }) => commentId));
      postToPreview({
        type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
        payload: { anchors },
      });
    },
    [postToPreview]
  );

  const resolveAnchors = useCallback(() => {
    if (!iframeLoaded) {
      setResolvedAnchors({});
      return;
    }
    if (trackedAnchors.length === 0) setResolvedAnchors({});
    postTrackedAnchors(trackedAnchors);
  }, [iframeLoaded, postTrackedAnchors, trackedAnchors]);

  const handleIframeLoad = useStableCallback(() => {
    // A new document starts its handshake from scratch; a live runtime re-reports
    // immediately in response to the SET_ANNOTATION_MODE message below.
    runtimeAliveRef.current = false;
    setIframeLoaded(true);
    onAnnotationAvailabilityChange(false);
    onLoadingChange(false);
    if (runtimeHandshakeTimerRef.current) clearTimeout(runtimeHandshakeTimerRef.current);
    runtimeHandshakeTimerRef.current = setTimeout(() => {
      runtimeHandshakeTimerRef.current = null;
      onAnnotationAvailabilityChange(false);
      onRuntimeError(
        t(
          'sessions.browser.errors.annotationRuntimeMissing',
          'The page loaded, but the annotation runtime did not become ready.'
        )
      );
    }, 3_000);
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
    if (!iframe) return;
    if (documentHtml !== undefined) {
      runtimeAliveRef.current = false;
      syncFrameLoadState(false);
      iframe.srcdoc = documentHtml;
      return;
    }
    let nextSrc = viewerUrl;
    try {
      nextSrc = buildManagedViewerUrlForLogicalUrl(viewerUrl, logicalUrl);
    } catch {
      // Fall back to the acquire-time viewer URL when the logical URL is unusable.
    }
    runtimeAliveRef.current = false;
    syncFrameLoadState(false);
    iframe.src = nextSrc;
  });

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    const measure = () => setViewport({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    return observeResizeOnAnimationFrame(surface, measure);
  }, []);

  useLayoutEffect(() => {
    const host = iframeHostRef.current;
    if (!host) return undefined;
    const frame = acquireManagedPreviewFrame({
      sessionId: session.id,
      viewerUrl,
      title: managedFrameTitleRef.current,
      host,
      documentHtml,
    });
    iframeRef.current = frame.iframe;
    frame.iframe.addEventListener('load', handleIframeLoad);
    syncFrameLoadState(frame.loaded);
    return () => {
      frame.iframe.removeEventListener('load', handleIframeLoad);
      if (iframeRef.current === frame.iframe) iframeRef.current = null;
      releaseManagedPreviewFrame(session.id, frame.iframe);
    };
  }, [documentHtml, handleIframeLoad, session.id, syncFrameLoadState, viewerUrl]);

  useEffect(() => {
    managedFrameTitleRef.current = managedFrameTitle;
    const iframe = iframeRef.current;
    if (iframe) iframe.title = managedFrameTitle;
  }, [managedFrameTitle]);

  useEffect(() => {
    if (runtimeHandshakeTimerRef.current) {
      clearTimeout(runtimeHandshakeTimerRef.current);
      runtimeHandshakeTimerRef.current = null;
    }
    runtimeAliveRef.current = false;
    setSelectedTarget(null);
    setDraftBody('');
    setResolvedAnchors({});
    onAnnotationAvailabilityChange(false);
    onRuntimeError(null);
    return () => {
      if (runtimeHandshakeTimerRef.current) {
        clearTimeout(runtimeHandshakeTimerRef.current);
        runtimeHandshakeTimerRef.current = null;
      }
    };
  }, [documentHtml, onAnnotationAvailabilityChange, onRuntimeError, session.id, viewerUrl]);

  useEffect(() => {
    if (iframeLoaded) {
      postToPreview({ type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled: annotationEnabled });
    }
  }, [annotationEnabled, iframeLoaded, postToPreview]);

  useEffect(() => {
    if (!command || command.id === handledCommandIdRef.current) return;
    if (
      command.action === 'reload' &&
      (documentHtml !== undefined || !iframeLoaded || !runtimeAliveRef.current)
    ) {
      // The document has no live runtime to receive the message (stuck load,
      // proxy error page, CSP-blocked script): reload from the parent instead
      // by re-navigating the frame to the current page's viewer URL.
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

  useEffect(() => {
    resolveAnchors();
  }, [resolveAnchors]);

  useEffect(() => {
    setActiveCommentId((current) =>
      current !== null && !visibleCommentIds.has(current) ? null : current
    );
    setCollapsedCommentIds((current) => current.filter((id) => visibleCommentIds.has(id)));
  }, [visibleCommentIds]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== previewOrigin || event.source !== iframeRef.current?.contentWindow)
        return;
      if (isManagedBrowserStateMessage(event.data)) {
        runtimeAliveRef.current = true;
        if (runtimeHandshakeTimerRef.current) {
          clearTimeout(runtimeHandshakeTimerRef.current);
          runtimeHandshakeTimerRef.current = null;
        }
        let mappedUrl: string;
        try {
          mappedUrl =
            documentHtml === undefined
              ? toManagedLogicalUrl(event.data.payload.url, logicalUrl)
              : logicalUrl;
        } catch {
          onAnnotationAvailabilityChange(false);
          onRuntimeError(
            t(
              'sessions.browser.errors.invalidRuntimePageUrl',
              'The managed preview runtime reported an invalid page URL.'
            )
          );
          return;
        }
        onAnnotationAvailabilityChange(true);
        onRuntimeError(null);
        onLoadingChange(event.data.payload.loading);
        onBrowserStateChange({
          ...event.data.payload,
          url: mappedUrl,
        });
        postTrackedAnchors(trackedAnchors);
      } else if (isManagedBrowserNavigationRequestMessage(event.data)) {
        onNavigationRequest(event.data.payload.url);
      } else if (isVisualAnnotationAnchorsResolvedMessage(event.data)) {
        const message = event.data;
        startTransition(() => {
          setResolvedAnchors(
            Object.fromEntries(
              message.payload.results
                .filter((result) => trackedAnchorIdsRef.current.has(result.commentId))
                .map((result) => [result.commentId, result])
            )
          );
        });
      } else if (isVisualAnnotationTargetMessage(event.data)) {
        const message = event.data;
        let pageUrl: string;
        try {
          pageUrl =
            documentHtml === undefined
              ? toManagedLogicalUrl(message.payload.page.url, logicalUrl)
              : logicalUrl;
        } catch {
          onRuntimeError(
            t(
              'sessions.browser.errors.invalidRuntimePageUrl',
              'The managed preview runtime reported an invalid page URL.'
            )
          );
          return;
        }
        startTransition(() => {
          setSelectedTarget({
            ...message.payload,
            page: {
              ...message.payload.page,
              url: pageUrl,
              pathname: new URL(pageUrl).pathname,
            },
          });
          setDraftBody('');
        });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    documentHtml,
    logicalUrl,
    onAnnotationAvailabilityChange,
    onBrowserStateChange,
    onLoadingChange,
    onNavigationRequest,
    onRuntimeError,
    postTrackedAnchors,
    previewOrigin,
    t,
    trackedAnchors,
  ]);

  const submitDraft = useCallback(async () => {
    if (!selectedTarget || !draftBody.trim() || submitting) return;
    setSubmitting(true);
    try {
      const comment = await commentDoc.createComment({
        turnId: commentTurnId,
        body: draftBody,
        anchor: createMinimalVisualAnnotationAnchor(selectedTarget),
      });
      onAddVisualAnnotationToChat?.(createVisualAnnotationReferenceFromPreviewComment(comment));
      postTrackedAnchors([
        ...comments
          .filter((existingComment) => existingComment.id !== comment.id)
          .map((existingComment) => ({
            commentId: existingComment.id,
            anchor: existingComment.anchor,
          })),
        { commentId: comment.id, anchor: comment.anchor },
      ]);
      setActiveCommentId(comment.id);
      setCollapsedCommentIds((current) => current.filter((id) => id !== comment.id));
      setSelectedTarget(null);
      setDraftBody('');
    } catch (error) {
      toast.error(t('sessions.preview.annotation.createFailed', 'Failed to add preview comment'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    commentDoc,
    commentTurnId,
    comments,
    draftBody,
    onAddVisualAnnotationToChat,
    postTrackedAnchors,
    selectedTarget,
    submitting,
    t,
  ]);

  const toggleResolved = useCallback(
    ({ commentId, resolved }: { commentId: string; resolved: boolean }) => {
      void commentDoc.toggleResolved({ commentId, resolved }).catch((error) => {
        toast.error(
          t('sessions.preview.annotation.resolveFailed', 'Failed to update preview comment'),
          { description: error instanceof Error ? error.message : String(error) }
        );
      });
    },
    [commentDoc, t]
  );

  const sendToChat = useCallback(
    (comment: PreviewVisualComment) => {
      onToggleVisualAnnotationInChat?.(createVisualAnnotationReferenceFromPreviewComment(comment));
    },
    [onToggleVisualAnnotationInChat]
  );

  return (
    <div
      ref={surfaceRef}
      className={cn('relative min-h-0 flex-1 overflow-hidden bg-white', className)}
    >
      {!iframeLoaded ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      <div ref={iframeHostRef} className="h-full w-full" />
      <VisualAnnotationCommentsOverlay
        comments={comments}
        viewport={viewport}
        collapsedCommentIds={collapsedCommentIds}
        activeCommentId={activeCommentId}
        onSelectComment={setActiveCommentId}
        onToggleCollapsed={(commentId) =>
          setCollapsedCommentIds((current) =>
            current.includes(commentId)
              ? current.filter((id) => id !== commentId)
              : [...current, commentId]
          )
        }
        onToggleResolved={toggleResolved}
        onSendToChat={onToggleVisualAnnotationInChat ? sendToChat : undefined}
        stagedCommentIds={stagedCommentIds}
        resolvedAnchors={resolvedAnchors}
      />
      {annotationEnabled &&
      selectedTarget &&
      isResolvedAnchorVisible(resolvedAnchors[DRAFT_VISUAL_ANNOTATION_ANCHOR_ID], viewport) ? (
        <div
          data-lody-visual-comment-draft="true"
          className="pointer-events-auto absolute z-30 w-[280px] max-w-[calc(100%-24px)] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          style={getDraftPosition(
            selectedTarget,
            viewport,
            resolvedAnchors[DRAFT_VISUAL_ANNOTATION_ANCHOR_ID]
          )}
        >
          <div className="mb-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold">
                {t('sessions.preview.annotation.addComment', 'Add comment')}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {getTargetLabel(selectedTarget)}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-label={t('common.cancel', 'Cancel')}
              onClick={() => {
                setSelectedTarget(null);
                setDraftBody('');
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            placeholder={t('sessions.preview.annotation.placeholder', 'Describe the change...')}
            className="min-h-20 resize-none bg-background text-xs"
            autoFocus
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!draftBody.trim() || submitting}
              onClick={() => void submitDraft()}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {t('sessions.preview.annotation.send', 'Send')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
