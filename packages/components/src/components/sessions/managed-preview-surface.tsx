import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Send, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { type SessionMeta, type VisualAnnotationReferencePayload } from '@lody/shared';
import {
  createMinimalVisualAnnotationAnchor,
  type VisualAnnotationInspectPayload,
} from '@lody/shared/visual-annotation-inspector';
import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
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
  type ManagedBrowserStateMessage,
} from '@lody/shared/visual-annotation-types';
import {
  createVisualAnnotationReferenceFromPreviewComment,
  type PreviewVisualComment,
} from '@lody/shared/preview-comment-types';

import { userAtom } from '@/atoms';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { toast } from '@/lib/toast';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { getVisiblePreviewVisualComments } from '@/components/preview/preview-visual-comments';
import {
  EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS,
  getVisualAnnotationReferenceKey,
} from '@/components/chat/visual-annotation-reference-state';
import { usePreviewVisualCommentDoc } from '@/hooks/use-preview-visual-comment-doc';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationVersion } from '@/hooks/use-conversation-view';
import { resolveActiveAssistantTurnIdFromIndex } from '@/lib/conversation-view';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { getManagedPageKey } from '@/lib/session-browser-url';
import { useManagedPreviewFrame } from './use-managed-preview-frame';

const styles = stylex.create({
  root: {
    position: 'relative',
    minHeight: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    // The managed preview surface has always been a white viewport, including in dark theme.
    backgroundColor: '#fff',
  },
  iframeHost: { width: '100%', height: '100%' },
  loadingIndicator: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    zIndex: 10,
    pointerEvents: 'none',
    color: colors.secondaryLabel,
  },
  annotationDraft: {
    position: 'absolute',
    zIndex: 30,
    width: '280px',
    maxWidth: 'calc(100% - 24px)',
    pointerEvents: 'auto',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: '6px',
    backgroundColor: 'hsl(var(--popover))',
    padding: '12px',
    color: 'hsl(var(--popover-foreground))',
    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  },
  draftHeader: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' },
  draftHeading: { minWidth: 0, flex: '1 1 0%' },
  draftTitle: { fontSize: '0.75rem', lineHeight: '1rem', fontWeight: 600 },
  draftTarget: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'monospace',
    fontSize: '10px',
    color: colors.secondaryLabel,
  },
  draftCancelIcon: { width: '14px', height: '14px' },
  draftSubmitRow: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' },
  draftSubmitIcon: { width: '14px', height: '14px' },
});

type ManagedPreviewSurfaceProps = {
  session: SessionMeta;
  viewerUrl: string;
  annotationEnabled: boolean;
  logicalUrl: string;
  command?: { id: number; action: ManagedBrowserCommand };
  className?: string;
  documentHtml?: string;
  /** See `ManagedPreviewFrameOptions.scriptsOptedIn`. */
  scriptsOptedIn?: boolean;
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
  scriptsOptedIn,
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
  const iframeHostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
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
  const managedFrameTitle = t('sessions.browser.managedFrameTitle', 'Managed preview');
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
  const { history: conversationView } = sessionDoc;
  const conversationVersion = useConversationVersion(conversationView);
  const commentTurnId = useMemo(
    () =>
      (conversationView ? resolveActiveAssistantTurnIdFromIndex(conversationView) : undefined) ??
      session.latestUserMsgId ??
      session.id,
    // `conversationVersion` is the change signal for the view's index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationVersion, conversationView, session.latestUserMsgId, session.id]
  );

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

  const trackedAnchorsRef = useRef<readonly TrackedVisualAnnotationAnchor[]>([]);
  const postTrackedAnchorsRef = useRef<(anchors: readonly TrackedVisualAnnotationAnchor[]) => void>(
    () => {}
  );
  const invalidRuntimeUrlMessage = t(
    'sessions.browser.errors.invalidRuntimePageUrl',
    'The managed preview runtime reported an invalid page URL.'
  );
  const handleBrowserStateChange = useStableCallback(
    (state: ManagedBrowserStateMessage['payload']) => {
      onBrowserStateChange(state);
      postTrackedAnchorsRef.current(trackedAnchorsRef.current);
    }
  );
  const handleRuntimeMessage = useStableCallback((data: unknown) => {
    if (isVisualAnnotationAnchorsResolvedMessage(data)) {
      startTransition(() => {
        setResolvedAnchors(
          Object.fromEntries(
            data.payload.results
              .filter((result) => trackedAnchorIdsRef.current.has(result.commentId))
              .map((result) => [result.commentId, result])
          )
        );
      });
    } else if (isVisualAnnotationTargetMessage(data)) {
      let pageUrl: string;
      try {
        pageUrl = mapRuntimeUrl(data.payload.page.url);
      } catch {
        onRuntimeError(invalidRuntimeUrlMessage);
        return;
      }
      startTransition(() => {
        setSelectedTarget({
          ...data.payload,
          page: {
            ...data.payload.page,
            url: pageUrl,
            pathname: new URL(pageUrl).pathname,
          },
        });
        setDraftBody('');
      });
    }
  });
  const { iframeLoaded, postToPreview, mapRuntimeUrl } = useManagedPreviewFrame({
    hostRef: iframeHostRef,
    sessionId: session.id,
    viewerUrl,
    logicalUrl,
    documentHtml,
    scriptsOptedIn,
    title: managedFrameTitle,
    annotationEnabled,
    command,
    invalidRuntimeUrlMessage,
    onAnnotationAvailabilityChange,
    onRuntimeError,
    onLoadingChange,
    onBrowserStateChange: handleBrowserStateChange,
    onNavigationRequest,
    onRuntimeMessage: handleRuntimeMessage,
  });
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

  useLayoutEffect(() => {
    trackedAnchorsRef.current = trackedAnchors;
    postTrackedAnchorsRef.current = postTrackedAnchors;
  }, [postTrackedAnchors, trackedAnchors]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    const measure = () => setViewport({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    return observeResizeOnAnimationFrame(surface, measure);
  }, []);

  useEffect(() => {
    setSelectedTarget(null);
    setDraftBody('');
    setResolvedAnchors({});
  }, [documentHtml, session.id, viewerUrl]);

  useEffect(() => {
    resolveAnchors();
  }, [resolveAnchors]);

  useEffect(() => {
    setActiveCommentId((current) =>
      current !== null && !visibleCommentIds.has(current) ? null : current
    );
    setCollapsedCommentIds((current) => current.filter((id) => visibleCommentIds.has(id)));
  }, [visibleCommentIds]);

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

  const rootStyle = stylex.props(styles.root);
  return (
    <div
      ref={surfaceRef}
      {...rootStyle}
      className={[rootStyle.className, className].filter(Boolean).join(' ')}
    >
      {!iframeLoaded ? (
        <div {...stylex.props(styles.loadingIndicator)}>
          <Spinner size="medium" />
        </div>
      ) : null}
      <div ref={iframeHostRef} {...stylex.props(styles.iframeHost)} />
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
          {...stylex.props(styles.annotationDraft)}
          style={getDraftPosition(
            selectedTarget,
            viewport,
            resolvedAnchors[DRAFT_VISUAL_ANNOTATION_ANCHOR_ID]
          )}
        >
          <div {...stylex.props(styles.draftHeader)}>
            <div {...stylex.props(styles.draftHeading)}>
              <div {...stylex.props(styles.draftTitle)}>
                {t('sessions.preview.annotation.addComment', 'Add comment')}
              </div>
              <div {...stylex.props(styles.draftTarget)}>{getTargetLabel(selectedTarget)}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              className="shrink-0"
              aria-label={t('common.cancel', 'Cancel')}
              onClick={() => {
                setSelectedTarget(null);
                setDraftBody('');
              }}
            >
              <X {...stylex.props(styles.draftCancelIcon)} />
            </Button>
          </div>
          <Textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            placeholder={t('sessions.preview.annotation.placeholder', 'Describe the change...')}
            className="min-h-20 resize-none bg-background text-xs"
            autoFocus
          />
          <div {...stylex.props(styles.draftSubmitRow)}>
            <Button
              type="button"
              size="small"
              disabled={!draftBody.trim() || submitting}
              onClick={() => void submitDraft()}
            >
              {submitting ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Send {...stylex.props(styles.draftSubmitIcon)} />
              )}
              {t('sessions.preview.annotation.send', 'Send')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
