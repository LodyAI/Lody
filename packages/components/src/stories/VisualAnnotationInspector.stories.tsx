import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Check, MousePointer2, RefreshCw, SendHorizontal, Trash2, X } from 'lucide-react';
import {
  RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
  SET_ANNOTATION_MODE_MESSAGE_TYPE,
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE,
  createMinimalVisualAnnotationAnchor,
  createVisualCommentInspector,
} from '@lody/shared/visual-annotation-inspector';
import {
  createPreviewVisualComment,
  createVisualAnnotationReferenceFromPreviewComment,
  getPreviewCommentRoomId,
} from '@lody/shared/preview-comment-types';
import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { SessionId, SessionInputBlock } from '@lody/shared';
import type {
  VisualAnnotationInspectPayload,
  VisualAnnotationAnchorsResolvedMessage,
  VisualAnnotationResolvedAnchor,
  VisualAnnotationTargetMessage,
  VisualCommentInspector,
} from '@lody/shared/visual-annotation-inspector';
import { VisualAnnotationCommentsOverlay } from '@/components/preview/visual-annotation-comments-overlay';
import { VisualAnnotationReferenceCard } from '@/components/ai-gui/visual-annotation-reference-card';
import { Button } from '@lody/ui/button';
import { Textarea } from '@/ui/textarea';

const storySessionId = 'session-storybook-visual-annotation' as SessionId;
const storyTurnId = 'turn-storybook-visual-annotation';
const storyAuthorId = 'storybook-user';
const storyAuthorName = 'Storybook User';
const storyRoomId = getPreviewCommentRoomId(storySessionId);

const devices = [
  { id: 'desktop', label: 'Desktop', width: 960, height: 620 },
  { id: 'mobile', label: 'Mobile', width: 390, height: 720 },
] as const;

type DeviceId = (typeof devices)[number]['id'];
type VisualAnnotationReferenceInputBlock = Extract<
  SessionInputBlock,
  { type: 'visual_annotation_reference' }
>;

const previewSrcDoc = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local Preview Fixture</title>
    <style>
      :root {
        color: #0f172a;
        background: #ffffff;
        font-family:
          -apple-system,
          BlinkMacSystemFont,
          "Inter",
          system-ui,
          sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 1320px;
        background: #ffffff;
      }

      .shell {
        display: grid;
        gap: 28px;
        padding: 40px 40px 520px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(260px, 0.9fr);
        gap: 28px;
        align-items: stretch;
      }

      .hero-copy {
        padding: 36px;
        border-radius: 20px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
      }

      .eyebrow {
        margin: 0 0 12px;
        color: #64748b;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      h1 {
        max-width: 780px;
        margin: 0;
        font-family: "Times New Roman", Georgia, serif;
        font-size: clamp(36px, 7vw, 72px);
        line-height: 0.95;
        letter-spacing: -0.04em;
        color: #0f172a;
      }

      .hero-copy p {
        max-width: 560px;
        margin: 18px 0 0;
        color: #475569;
        font-size: 15px;
        line-height: 1.65;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 24px;
      }

      button,
      a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 38px;
        border: 0;
        border-radius: 999px;
        padding: 0 18px;
        color: #ffffff;
        background: #0f172a;
        font: inherit;
        font-weight: 600;
        font-size: 13px;
        text-decoration: none;
        cursor: pointer;
      }

      button.secondary {
        color: #0f172a;
        background: #f1f5f9;
      }

      .panel {
        display: grid;
        align-content: space-between;
        min-height: 320px;
        padding: 28px;
        border-radius: 20px;
        background: #0f172a;
        color: #f8fafc;
      }

      .metric {
        display: grid;
        gap: 6px;
      }

      .metric span {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #94a3b8;
      }

      .metric strong {
        font-size: 48px;
        font-weight: 600;
        letter-spacing: -0.04em;
      }

      .panel p {
        margin: 0;
        color: #cbd5e1;
        font-size: 14px;
        line-height: 1.55;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
      }

      .card {
        padding: 22px;
        border-radius: 16px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
      }

      .card h2 {
        margin: 0 0 8px;
        font-size: 15px;
        color: #0f172a;
      }

      .card p,
      label {
        margin: 0;
        color: #64748b;
        font-size: 13px;
        line-height: 1.55;
      }

      form {
        display: grid;
        gap: 10px;
      }

      input {
        width: 100%;
        height: 38px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 0 12px;
        color: #0f172a;
        background: #ffffff;
        font: inherit;
        font-size: 13px;
      }

      .below-fold {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.65fr);
        gap: 16px;
        margin-top: 420px;
      }

      .audit-card {
        padding: 26px;
        border-radius: 18px;
        background: #f8fafc;
        border: 1px solid #dbe3ee;
      }

      .audit-card h2 {
        margin: 0 0 10px;
        font-size: 20px;
        color: #0f172a;
      }

      .audit-card p {
        margin: 0;
        color: #475569;
        font-size: 14px;
        line-height: 1.6;
      }

      @media (max-width: 680px) {
        .shell {
          padding: 22px;
        }

        .hero,
        .grid,
        .below-fold {
          grid-template-columns: 1fr;
        }

        .hero-copy {
          padding: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero" data-testid="marketing-hero">
        <div class="hero-copy">
          <p class="eyebrow">Preview fixture</p>
          <h1>Design reviews should point at pixels.</h1>
          <p>
            This iframe behaves like a tunneled preview page. Enable annotation mode in the
            parent panel, hover elements, then click a card, button, input, or SVG icon.
          </p>
          <div class="actions">
            <button data-testid="primary-cta" aria-label="Start visual review">
              <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M2 9h11M9 5l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
              Start review
            </button>
            <button class="secondary" role="button" data-cy="secondary-action">
              Open changelog
            </button>
          </div>
        </div>
        <aside class="panel" role="complementary" aria-label="Release health">
          <div class="metric">
            <span>Review confidence</span>
            <strong>94%</strong>
          </div>
          <p>Selectors, text snippets, rect ratios, and nearby context are captured for AI.</p>
        </aside>
      </section>

      <section class="grid" aria-label="Inspector targets">
        <article class="card" data-testid="spacing-card">
          <h2>Spacing regression</h2>
          <p>The toolbar gap feels too wide when the viewport switches to mobile.</p>
        </article>
        <article class="card" data-testid="copy-card">
          <h2>Ambiguous copy</h2>
          <p>Click this copy block to inspect ancestor summaries and nearby text.</p>
        </article>
        <form class="card" data-testid="signup-form">
          <h2>Signup form</h2>
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" value="designer@example.test" />
          <button type="submit" data-testid="submit-email">Send invite</button>
        </form>
      </section>

      <section class="below-fold" aria-label="Scrolled inspector targets">
        <article class="audit-card" data-testid="below-fold-audit-card">
          <h2>Below-fold QA checkpoint</h2>
          <p>
            This section sits far enough down the iframe to debug comments whose anchors leave the
            visible preview viewport during scroll.
          </p>
        </article>
        <button class="secondary" data-testid="below-fold-action">Review later</button>
      </section>
    </main>
  </body>
</html>`;

const isVisualAnnotationTargetMessage = (
  value: unknown
): value is VisualAnnotationTargetMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === VISUAL_ANNOTATION_TARGET_MESSAGE_TYPE;
};

const isVisualAnnotationAnchorsResolvedMessage = (
  value: unknown
): value is VisualAnnotationAnchorsResolvedMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { type?: unknown }).type === VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE;
};

function VisualAnnotationInspectorHarness() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inspectorRef = useRef<VisualCommentInspector | null>(null);
  const [deviceId, setDeviceId] = useState<DeviceId>('desktop');
  const [annotationMode, setAnnotationMode] = useState(false);
  const [selectedPayload, setSelectedPayload] = useState<VisualAnnotationInspectPayload | null>(
    null
  );
  const [draftBody, setDraftBody] = useState('This element needs a tighter mobile layout.');
  const [comments, setComments] = useState<PreviewVisualComment[]>([]);
  const [stagedReferences, setStagedReferences] = useState<VisualAnnotationReferenceInputBlock[]>(
    []
  );
  const [sentReferences, setSentReferences] = useState<VisualAnnotationReferenceInputBlock[]>([]);
  const [resolvedAnchors, setResolvedAnchors] = useState<
    Record<string, VisualAnnotationResolvedAnchor>
  >({});
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<string[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === deviceId) ?? devices[0],
    [deviceId]
  );
  const pendingCount = useMemo(
    () => comments.filter((comment) => comment.status === 'completed').length,
    [comments]
  );
  const stagedCommentIds = useMemo(
    () => stagedReferences.map((reference) => reference.commentId),
    [stagedReferences]
  );

  const setInspectorMode = (enabled: boolean) => {
    inspectorRef.current?.setEnabled(enabled);
    iframeRef.current?.contentWindow?.postMessage(
      { type: SET_ANNOTATION_MODE_MESSAGE_TYPE, enabled },
      '*'
    );
  };

  const attachInspector = () => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }
    inspectorRef.current?.destroy();
    const parentOrigin = window.location.origin;
    inspectorRef.current = createVisualCommentInspector({
      targetWindow: frameWindow,
      allowedParentOrigins: parentOrigin === 'null' ? undefined : [parentOrigin],
      postMessageTargetOrigin: parentOrigin === 'null' ? '*' : parentOrigin,
    });
    setIframeReady(true);
    setInspectorMode(annotationMode);
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      const source = event.source;
      if (source !== iframeRef.current?.contentWindow && source !== window) {
        return;
      }
      const message = event.data;
      if (isVisualAnnotationAnchorsResolvedMessage(message)) {
        startTransition(() => {
          setResolvedAnchors(
            Object.fromEntries(message.payload.results.map((result) => [result.commentId, result]))
          );
        });
        return;
      }
      if (isVisualAnnotationTargetMessage(message)) {
        startTransition(() => {
          setSelectedPayload(message.payload);
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      inspectorRef.current?.destroy();
      inspectorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (iframeReady) {
      setInspectorMode(annotationMode);
    }
  }, [annotationMode, iframeReady]);

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!iframeReady || !frameWindow) {
      return;
    }
    frameWindow.postMessage(
      {
        type: RESOLVE_VISUAL_ANNOTATION_ANCHORS_MESSAGE_TYPE,
        payload: {
          anchors: comments.map((comment) => ({
            commentId: comment.id,
            anchor: comment.anchor,
          })),
        },
      },
      '*'
    );
  }, [comments, iframeReady]);

  const completeComment = () => {
    const body = draftBody.trim();
    if (!selectedPayload || body.length === 0) {
      return;
    }
    const createdAt = Date.now();
    const comment = createPreviewVisualComment({
      id: `visual-comment-${createdAt}`,
      turnId: storyTurnId,
      body,
      anchor: createMinimalVisualAnnotationAnchor(selectedPayload),
      authorId: storyAuthorId,
      authorName: storyAuthorName,
      createdAt,
    });
    setComments((current) => [comment, ...current]);
    setActiveCommentId(comment.id);
    setCollapsedCommentIds((current) => current.filter((id) => id !== comment.id));
    setSelectedPayload(null);
    setDraftBody('');
  };

  const createReferenceInputBlock = (
    comment: PreviewVisualComment
  ): VisualAnnotationReferenceInputBlock => ({
    type: 'visual_annotation_reference',
    ...createVisualAnnotationReferenceFromPreviewComment(comment),
  });

  const toggleCommentStaged = (comment: PreviewVisualComment) => {
    if (comment.status !== 'completed') {
      return;
    }
    const reference = createReferenceInputBlock(comment);
    setStagedReferences((current) =>
      current.some((item) => item.commentId === comment.id)
        ? current.filter((item) => item.commentId !== comment.id)
        : [reference, ...current]
    );
    setActiveCommentId(comment.id);
  };

  const stagePending = () => {
    const commentsToStage = comments.filter((comment) => comment.status === 'completed');
    if (commentsToStage.length === 0) {
      return;
    }
    setStagedReferences((current) => {
      const existingIds = new Set(current.map((reference) => reference.commentId));
      const nextReferences = commentsToStage
        .filter((comment) => !existingIds.has(comment.id))
        .map(createReferenceInputBlock);
      return nextReferences.length > 0 ? [...nextReferences, ...current] : current;
    });
    setActiveCommentId(commentsToStage[0]?.id ?? null);
  };

  const removeStagedReference = (commentId: string) => {
    setStagedReferences((current) =>
      current.filter((reference) => reference.commentId !== commentId)
    );
  };

  const sendStagedReferences = () => {
    if (stagedReferences.length === 0) {
      return;
    }
    const submittedAt = Date.now();
    const submittedMessageId = `storybook-message-${submittedAt}`;
    const stagedIds = new Set(stagedReferences.map((reference) => reference.commentId));

    setSentReferences((current) => {
      const existingIds = new Set(current.map((reference) => reference.commentId));
      const nextReferences = stagedReferences
        .filter((reference) => !existingIds.has(reference.commentId))
        .map(
          (reference): VisualAnnotationReferenceInputBlock => ({
            ...reference,
            status: 'submitted',
          })
        );
      return nextReferences.length > 0 ? [...nextReferences, ...current] : current;
    });
    setComments((current) =>
      current.map((comment) =>
        stagedIds.has(comment.id)
          ? {
              ...comment,
              status: 'submitted',
              updatedAt: submittedAt,
              submittedAt,
              submittedMessageId,
            }
          : comment
      )
    );
    setStagedReferences([]);
    setActiveCommentId(stagedReferences[0]?.commentId ?? null);
  };

  const resetHarness = () => {
    setAnnotationMode(false);
    setSelectedPayload(null);
    setDraftBody('This element needs a tighter mobile layout.');
    setComments([]);
    setStagedReferences([]);
    setSentReferences([]);
    setResolvedAnchors({});
    setCollapsedCommentIds([]);
    setActiveCommentId(null);
    setInspectorMode(false);
  };

  const scrollPreviewTo = (top: number) => {
    iframeRef.current?.contentWindow?.scrollTo({ top, left: 0, behavior: 'smooth' });
  };

  const toggleCommentCollapsed = (commentId: string) => {
    setCollapsedCommentIds((current) =>
      current.includes(commentId)
        ? current.filter((id) => id !== commentId)
        : [...current, commentId]
    );
    setActiveCommentId((current) => (current === commentId ? null : current));
  };

  const toggleCommentResolved = (input: { commentId: string; resolved: boolean }) => {
    const updatedAt = Date.now();
    setComments((current) =>
      current.map((comment) => {
        if (comment.id !== input.commentId) {
          return comment;
        }
        const next: PreviewVisualComment = { ...comment, updatedAt };
        if (input.resolved) {
          next.resolvedAt = updatedAt;
          next.resolvedBy = storyAuthorId;
        } else {
          delete next.resolvedAt;
          delete next.resolvedBy;
        }
        return next;
      })
    );
    setActiveCommentId(input.resolved ? null : input.commentId);
  };

  return (
    <div className="min-h-[820px] bg-slate-100 p-6 text-slate-900">
      <div className="mx-auto grid max-w-[1440px] gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="overflow-hidden rounded-2xl bg-white p-4 shadow-xs ring-1 ring-slate-200">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Iframe harness
              </p>
              <h2 className="mt-1 text-base font-semibold text-slate-900">
                Live annotation preview
              </h2>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {devices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    deviceId === device.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                  onClick={() => {
                    setDeviceId(device.id);
                    setIframeReady(false);
                    setSelectedPayload(null);
                    setResolvedAnchors({});
                  }}
                >
                  {device.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-auto rounded-xl bg-slate-200/60 p-4 ring-1 ring-slate-200">
            <div
              className="relative mx-auto"
              style={{
                width: selectedDevice.width,
                height: selectedDevice.height,
              }}
            >
              {/* eslint-disable-next-line react/iframe-missing-sandbox -- Storybook fixture is static srcDoc; sandbox blocks the parent-owned targetWindow harness. */}
              <iframe
                key={deviceId}
                ref={iframeRef}
                title="Visual annotation preview fixture"
                srcDoc={previewSrcDoc}
                onLoad={attachInspector}
                className="block h-full w-full rounded-lg bg-white shadow-xs ring-1 ring-slate-200"
              />
              <VisualAnnotationCommentsOverlay
                comments={comments}
                viewport={selectedDevice}
                collapsedCommentIds={collapsedCommentIds}
                activeCommentId={activeCommentId}
                onSelectComment={setActiveCommentId}
                onToggleCollapsed={toggleCommentCollapsed}
                onToggleResolved={toggleCommentResolved}
                onSendToChat={toggleCommentStaged}
                stagedCommentIds={stagedCommentIds}
                resolvedAnchors={resolvedAnchors}
              />
            </div>
          </div>
        </section>

        <aside className="space-y-4 rounded-2xl bg-white p-4 shadow-xs ring-1 ring-slate-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Parent controls
              </p>
              <h2 className="mt-1 text-base font-semibold text-slate-900">Annotation mode</h2>
            </div>
            <Button
              type="button"
              variant={annotationMode ? 'primary' : 'secondary'}
              size="small"
              onClick={() => {
                const next = !annotationMode;
                setAnnotationMode(next);
                setInspectorMode(next);
              }}
            >
              <MousePointer2 className="h-3.5 w-3.5" />
              {annotationMode ? 'On' : 'Off'}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => scrollPreviewTo(0)}
            >
              Scroll top
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => scrollPreviewTo(760)}
            >
              Below fold
            </Button>
          </div>

          <div className="rounded-xl bg-slate-50 p-3 text-xs ring-1 ring-slate-200">
            <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-y-1.5">
              <span className="text-slate-500">Doc</span>
              <span className="break-all font-mono text-slate-700">{storyRoomId}</span>
              <span className="text-slate-500">Turn</span>
              <span className="break-all font-mono text-slate-700">{storyTurnId}</span>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Selected target</h3>
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
                {selectedPayload ? selectedPayload.target.tag : 'none'}
              </span>
            </div>
            {selectedPayload ? (
              <div className="space-y-3">
                <p className="break-all font-mono text-[11px] text-slate-600">
                  {selectedPayload.target.selector}
                </p>
                <Textarea
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  placeholder="Write a comment for this selected target..."
                  className="min-h-20 bg-white text-sm"
                />
                <Button type="button" size="small" className="w-full" onClick={completeComment}>
                  <Check className="h-3.5 w-3.5" />
                  Add comment
                </Button>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-500">
                Turn annotation on, hover the iframe, then click an element. The click is captured
                inside the iframe and posted back here.
              </p>
            )}
          </div>

          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Comments</h3>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                {pendingCount} completed
              </span>
            </div>
            <div className="max-h-[240px] space-y-1.5 overflow-auto pr-1">
              {comments.length > 0 ? (
                comments.map((comment) => {
                  const isResolved = comment.resolvedAt !== undefined;
                  const isSubmitted = comment.status === 'submitted';
                  const isStaged = stagedCommentIds.includes(comment.id);
                  return (
                    <button
                      key={comment.id}
                      type="button"
                      onClick={() => setActiveCommentId(comment.id)}
                      className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                        activeCommentId === comment.id
                          ? 'bg-white shadow-xs ring-1 ring-slate-300'
                          : 'hover:bg-white/70'
                      }`}
                    >
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          isSubmitted
                            ? 'bg-slate-400'
                            : isStaged
                              ? 'bg-sky-500'
                              : isResolved
                                ? 'bg-emerald-500'
                                : 'bg-amber-500'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">
                          {comment.body}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                          {comment.anchor.target.tag}
                          {isSubmitted ? ' · submitted' : isStaged ? ' · staged' : ''}
                          {isResolved ? ' · resolved' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-1 py-2 text-xs leading-relaxed text-slate-500">
                  Comments stay here until you reset the harness, simulating the preview Loro doc
                  state.
                </p>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={pendingCount === 0}
                onClick={stagePending}
              >
                <SendHorizontal className="h-3.5 w-3.5" />
                Stage all
              </Button>
              <Button type="button" variant="secondary" size="small" onClick={resetHarness}>
                {comments.length > 0 || selectedPayload ? (
                  <Trash2 className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Reset
              </Button>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Composer draft</h3>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                {stagedReferences.length} staged
              </span>
            </div>
            {stagedReferences.length > 0 ? (
              <div className="space-y-2">
                <div className="max-h-[220px] space-y-2 overflow-auto pr-1">
                  {stagedReferences.map((reference) => (
                    <div
                      key={reference.commentId}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg bg-white p-2 shadow-xs ring-1 ring-slate-200"
                    >
                      <VisualAnnotationReferenceCard
                        reference={reference}
                        className="max-w-none"
                        onClick={() => setActiveCommentId(reference.commentId)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        icon
                        onClick={() => removeStagedReference(reference.commentId)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" size="small" onClick={sendStagedReferences}>
                    <SendHorizontal className="h-3.5 w-3.5" />
                    Send
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => setStagedReferences([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-500">
                Paper-plane actions add visual annotation references here first. The final send
                button moves staged references into conversation history.
              </p>
            )}
          </div>

          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Conversation</h3>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
                {sentReferences.length} sent
              </span>
            </div>
            {sentReferences.length > 0 ? (
              <div className="max-h-[220px] space-y-2 overflow-auto pr-1">
                {sentReferences.map((reference) => (
                  <div
                    key={reference.commentId}
                    className="rounded-lg bg-white p-2 shadow-xs ring-1 ring-slate-200"
                  >
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                      Session input block
                    </p>
                    <VisualAnnotationReferenceCard reference={reference} className="max-w-none" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-500">
                Sent visual annotation references appear here after the composer draft is submitted.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const meta = {
  title: 'Preview/VisualAnnotationInspector',
  component: VisualAnnotationInspectorHarness,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof VisualAnnotationInspectorHarness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LocalHarness: Story = {};
