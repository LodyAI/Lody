import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useState } from 'react';
import { createStore, Provider } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { MessageQueueItem, SessionId, WorkspaceId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { currentWorkspaceIdAtom } from '../atoms/workspace-context';
import { authTokenAtom } from '../atoms/runtime';
import { seedSessionImageCache } from '../lib/session-image-cache';
import {
  QueuedImagePreview,
  type QueuedImageBlock,
} from '../components/sessions/message-queue/queued-image-preview';
import { MessageQueueDisplay } from '../components/sessions/message-queue/message-queue-display';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';
import imageSourceUrl from '../assets/lody-icon.png';

const workspaceId = 'queued-image-migration-workspace' as WorkspaceId;
const sessionId = 'queued-image-migration-session' as SessionId;

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  column: {
    display: 'flex',
    width: 480,
    maxWidth: '100%',
    flexDirection: 'column',
    gap: themeSpace[4],
  },
  previews: { display: 'flex', alignItems: 'center', gap: themeSpace[4] },
  output: { minHeight: 24 },
});

const meta = {
  title: 'Sessions/QueuedImageMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({
  mode = 'ready',
  long = false,
  unnamed = false,
  queue = false,
}: {
  mode?: 'ready' | 'error' | 'controlled';
  long?: boolean;
  unnamed?: boolean;
  queue?: boolean;
}) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(currentWorkspaceIdAtom, workspaceId);
    next.set(authTokenAtom, mode === 'error' ? null : 'synthetic-story-token');
    return next;
  }, [mode]);
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<Blob | null>(null);
  const [events, setEvents] = useState('No row action performed');
  const [releaseImage, setReleaseImage] = useState<(() => void) | null>(null);
  const image = useMemo<QueuedImageBlock>(
    () => ({
      type: 'image',
      imageId: mode === 'controlled' ? 'queue-controlled-image' : 'queue-seeded-image',
      mimeType: 'image/png',
      sizeBytes: source?.size ?? 2048,
      ...(unnamed
        ? {}
        : {
            fileName: long
              ? '很长的设计预览文件名 — review-responsive-layout-and-keep-original-crop.png'
              : 'local-logo-fixture.png',
          }),
    }),
    [long, mode, source?.size, unnamed]
  );

  useEffect(() => {
    let active = true;
    void fetch(imageSourceUrl)
      .then((response) => response.blob())
      .then((blob) => {
        if (active) setSource(blob);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (mode === 'error') {
      setReady(true);
      return undefined;
    }
    if (!source) return undefined;
    if (mode === 'controlled') {
      // Only synthetic image transport is gated; the production loader and viewer run unchanged.
      const previous = window.fetch;
      const waiting = new Set<(response: Response) => void>();
      let released = false;
      const response = () =>
        new Response(source, { status: 200, headers: { 'Content-Type': 'image/png' } });
      const fixtureFetch: typeof fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/session-images/') || !url.includes('/queue-controlled-image'))
          return previous(input, init);
        return released
          ? Promise.resolve(response())
          : new Promise((resolve) => waiting.add(resolve));
      };
      window.fetch = fixtureFetch;
      setReleaseImage(() => () => {
        released = true;
        for (const resolve of waiting) resolve(response());
        waiting.clear();
      });
      setReady(true);
      return () => {
        active = false;
        if (window.fetch === fixtureFetch) window.fetch = previous;
        for (const resolve of waiting) resolve(new Response(null, { status: 404 }));
      };
    }
    void seedSessionImageCache({ workspaceId, sessionId, imageId: image.imageId }, source).then(
      () => {
        if (active) setReady(true);
      }
    );
    return () => {
      active = false;
    };
  }, [image.imageId, mode, source]);

  const item = useMemo<MessageQueueItem>(
    () => ({
      $cid: 'queued-preview-item',
      task: 'Review this image without editing or dragging the queued message',
      userId: 'storybook-user',
      userTurnId: 'queued-preview-turn',
      operationId: undefined,
      isEditing: undefined,
      editingStartedAt: undefined,
      project: undefined,
      timestamp: '2026-10-22T00:00:00.000Z',
      acpSessionConfig: {
        $cid: 'queued-preview-config',
        prompt: 'Review this image',
        cliType: 'builtin',
        agentType: 'claude-code',
        inputBlocks: [image],
        modeId: undefined,
        modelId: undefined,
        issuePRMentions: undefined,
        resume: undefined,
        configOptionValues: undefined,
        memory: undefined,
        mcpServerIds: undefined,
        agentRoleId: undefined,
        agentRoleRevision: undefined,
        agentRoleSnapshot: undefined,
        chainDepth: undefined,
      },
    }),
    [image]
  );

  return (
    <Provider store={store}>
      <div {...stylex.props(styles.canvas)}>
        <div {...stylex.props(styles.column)} data-queue-image-fixture data-fixture-ready={ready}>
          {ready ? (
            queue ? (
              <MessageQueueDisplay
                sessionId={sessionId}
                items={[item]}
                onRemove={() => setEvents('Removed queued item')}
                onReorder={() => setEvents('Reordered queued item')}
                onEditStart={() => setEvents('Editing queued item')}
                onEditCancel={() => setEvents('Cancelled edit')}
                onEditSave={() => setEvents('Saved queued item')}
                onSteer={() => setEvents('Steered queued item')}
                showSteerAction
              />
            ) : (
              <div {...stylex.props(styles.previews)}>
                <QueuedImagePreview sessionId={sessionId} image={image} />
                {mode !== 'controlled' ? (
                  <QueuedImagePreview sessionId={sessionId} image={image} size={40} />
                ) : null}
              </div>
            )
          ) : (
            <span>Preparing synthetic local image</span>
          )}
          {mode === 'controlled' ? (
            <Button onClick={() => releaseImage?.()}>Load synthetic image</Button>
          ) : null}
          <output {...stylex.props(styles.output)} data-queue-image-events>
            {events}
          </output>
        </div>
      </div>
    </Provider>
  );
}

export const ThumbnailSizes: Story = { render: () => <Fixture /> };
export const LongFilename: Story = { render: () => <Fixture long /> };
export const MissingFilename: Story = { render: () => <Fixture unnamed /> };
export const LoadControl: Story = { render: () => <Fixture mode="controlled" /> };
export const MissingAuth: Story = { render: () => <Fixture mode="error" /> };
export const InQueue: Story = { render: () => <Fixture queue /> };
