import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Provider, createStore } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { MachineId, SessionId, SessionMeta, WorkspaceId } from '@lody/shared';
import {
  VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE,
  type VisualAnnotationAnchorsResolvedMessage,
} from '@lody/shared/visual-annotation-types';
import { Button } from '@lody/ui/button';
import { runtimeAtom, userAtom, type WorkspaceRuntime } from '@/atoms';
import { setWorkspaceContextAtom } from '@/atoms/workspace-context';
import { createConversationViewFromHistory } from '@/lib/conversation-view';
import { ManagedPreviewSurface } from '@/components/sessions/managed-preview-surface';
import { clearManagedPreviewFrame } from '@/components/sessions/managed-preview-frame-cache';
import {
  buildStaticHtmlPreviewDocument,
  getStaticHtmlPreviewLogicalUrl,
} from '@/components/sessions/static-html-preview-document';

const styles = stylex.create({
  canvas: { display: 'flex', flexDirection: 'column', height: '100dvh' },
  controls: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 8 },
  frame: { display: 'flex', minHeight: 0, flexGrow: 1 },
});
const noop = () => undefined;
const unsubscribe = () => noop;
const emptyHistory: never[] = [];
const workspaceId = 'synthetic-managed-draft-workspace' as WorkspaceId;
const workspaceSlug = 'synthetic-managed-draft';
const pageHtml = `<!doctype html><html lang="en"><head><title>Synthetic preview target</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:16px system-ui;background:white;color:#171717}button{font:inherit;padding:12px 20px}</style>
</head><body><button id="synthetic-preview-target" type="button">Preview action</button></body></html>`;

function Fixture({
  scoped = false,
  transparentPage = false,
}: {
  scoped?: boolean;
  transparentPage?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requestedBody, setRequestedBody] = useState('');
  const [resolvedSelector, setResolvedSelector] = useState('');
  const frameHost = useRef<HTMLDivElement>(null);
  const rejectPending = useRef<((reason: Error) => void) | null>(null);
  const [fixture] = useState(() => {
    const session: SessionMeta = {
      id: `synthetic-managed-draft-${scoped ? 'scoped' : 'default'}${transparentPage ? '-transparent' : ''}` as SessionId,
      machineId: 'synthetic-managed-draft-machine' as MachineId,
      userId: 'synthetic-preview-author',
      createdAt: '2026-10-22T09:00:00.000Z',
      status: { type: 'idle' },
      cliType: 'builtin',
      agentType: 'codex',
    };
    const history = createConversationViewFromHistory({
      sessionId: session.id,
      getHistory: () => emptyHistory,
      subscribe: unsubscribe,
    });
    const sessionState = { session: { id: session.id }, mq: [], humanInputReceipts: {} };
    const commentState = { meta: { sessionId: session.id }, turns: {} };
    const sessionStore = {
      history,
      doc: null,
      getState: () => sessionState,
      getSyncState: () => 'synced' as const,
      subscribe: unsubscribe,
      subscribeSyncState: unsubscribe,
      acquireSync: unsubscribe,
    };
    const commentStore = {
      getState: () => commentState,
      getSyncState: () => 'synced' as const,
      subscribe: unsubscribe,
      subscribeSyncState: unsubscribe,
    };
    const writer = {
      mutatePreviewVisualComments: async (_sessionId, mutation) => {
        if (mutation.kind !== 'create') throw new Error('Unexpected synthetic preview mutation');
        setRequestedBody(mutation.comment.body);
        setPending(true);
        try {
          await new Promise<never>((_resolve, reject) => {
            rejectPending.current = reject;
          });
        } finally {
          rejectPending.current = null;
          setPending(false);
        }
      },
    } satisfies Pick<WorkspaceRuntime['writer'], 'mutatePreviewVisualComments'>;
    const runtime = {
      workspaceId,
      workspaceSlug,
      writer,
      peekSessionStore: () => sessionStore,
      acquireSessionStore: async () => sessionStore,
      releaseSessionStoreRef: noop,
      acquirePreviewVisualCommentStore: async () => commentStore,
      releasePreviewVisualCommentStoreRef: noop,
    } as unknown as WorkspaceRuntime;
    const store = createStore();
    store.set(userAtom, {
      id: session.userId,
      name: 'Synthetic preview author',
      email: 'preview-fixture@example.com',
      image: null,
    });
    store.set(setWorkspaceContextAtom, { workspaceId, slug: workspaceSlug });
    store.set(runtimeAtom, runtime);
    return {
      store,
      session,
      documentHtml: buildStaticHtmlPreviewDocument(
        transparentPage
          ? pageHtml
              .replace('background:white', 'background:transparent')
              .replace('<style>', '<style>html{color-scheme:light dark}')
          : pageHtml
      ),
      logicalUrl: getStaticHtmlPreviewLogicalUrl('/synthetic/preview/example.html'),
    };
  });
  useEffect(() => () => clearManagedPreviewFrame(fixture.session.id), [fixture.session.id]);
  useEffect(() => {
    const observeResolution = (event: MessageEvent<unknown>) => {
      const frame = frameHost.current?.querySelector('iframe');
      if (event.source !== frame?.contentWindow || event.origin !== 'null') return;
      const message = event.data as Partial<VisualAnnotationAnchorsResolvedMessage> | null;
      if (
        message?.type !== VISUAL_ANNOTATION_ANCHORS_RESOLVED_MESSAGE_TYPE ||
        !Array.isArray(message.payload?.results)
      )
        return;
      const target = message.payload.results.find(
        (result) =>
          result.resolved &&
          result.selector?.includes('synthetic-preview-target') &&
          result.rect != null &&
          result.rect.width > 0 &&
          result.rect.height > 0
      );
      setResolvedSelector(target?.selector ?? '');
    };
    window.addEventListener('message', observeResolution);
    return () => window.removeEventListener('message', observeResolution);
  }, []);

  return (
    <Provider store={fixture.store}>
      <section {...stylex.props(styles.canvas)} data-managed-draft-fixture>
        <div {...stylex.props(styles.controls)}>
          <output
            data-managed-draft-status
            data-available={available}
            data-loading={loading}
            data-pending={pending}
            data-runtime-error={runtimeError ?? ''}
            data-resolved-selector={resolvedSelector}
          >
            {pending ? 'Synthetic writer pending' : 'Synthetic preview ready'}
          </output>
          <Button
            size="small"
            disabled={!pending}
            onClick={() => rejectPending.current?.(new Error('Synthetic writer rejected'))}
          >
            Reject synthetic write
          </Button>
          <output data-managed-draft-requested-body>{requestedBody}</output>
        </div>
        <div
          {...stylex.props(styles.frame)}
          data-managed-draft-frame
          ref={frameHost}
          style={
            scoped
              ? ({
                  '--spacing': '5px',
                  ...(transparentPage ? { '--color-white': 'rgb(210, 236, 248)' } : {}),
                } as CSSProperties)
              : undefined
          }
        >
          <ManagedPreviewSurface
            session={fixture.session}
            viewerUrl={fixture.logicalUrl}
            logicalUrl={fixture.logicalUrl}
            documentHtml={fixture.documentHtml}
            annotationEnabled
            onAnnotationAvailabilityChange={setAvailable}
            onRuntimeError={setRuntimeError}
            onLoadingChange={setLoading}
            onBrowserStateChange={noop}
            onNavigationRequest={noop}
          />
        </div>
      </section>
    </Provider>
  );
}

const meta = {
  title: 'Migration/ManagedPreviewDraftSpinner',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const ScopedSpacing: Story = { args: { scoped: true } };

export const TransparentPage: Story = { args: { transparentPage: true } };
export const TransparentPageScoped: Story = { args: { transparentPage: true, scoped: true } };
