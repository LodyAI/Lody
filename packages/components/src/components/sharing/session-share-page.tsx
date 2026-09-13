import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, PanelLeft } from 'lucide-react';
import {
  SessionRowLeadingSlot,
  buildSessionRowOpenedByTreeSlot,
} from '../session-row-leading-slot';
import { toast } from 'sonner';
import { buildConversationMarkdown, type SessionId } from '@lody/shared';
import {
  openStaticShare,
  type StaticShare,
  type SharePackageManifest,
} from '@lody/shared/session-sharing';
import {
  createSessionShareReader,
  type SessionShareReaderSnapshot,
} from '@/lib/session-share-reader';
import {
  getSessionShareSearch,
  navigateSessionShareTab,
  resolveSessionShareTab,
  resolveSharePanes,
  subscribeSessionShareNavigation,
} from '@/lib/session-share-navigation';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { conversationCopyRange } from '@/lib/conversation-copy-range';
import { describeCopiedConversation } from '@/lib/describe-copied-conversation';
import { SessionChatStreamView, MessageRowView } from '../ai-gui/view';
import {
  buildChatStreamItems,
  type BuildChatStreamItemsCache,
} from '../ai-gui/build-chat-stream-items';
import { SessionReadonlyContext } from '../ai-gui/session-readonly-context';
import {
  SharedAttachmentUnavailable,
  SharedFile,
  SharedImage,
  type ShareAttachmentAccess,
} from './share-attachments';
import { SessionShareErrorBoundary } from './session-share-error-boundary';
import { Button } from '@/ui/button';
import { TabPillStrip, TAB_PILL_ACTIVE_CLASS } from '@/components/shared/tab-pill-strip';
import { cn } from '@/lib/utils';
import { useTheme } from '@/theme-provider';
import { SessionShareComposer } from './session-share-composer';
import {
  ShareBrandLink,
  ShareViewerIdentity,
  resolveShareAppOrigin,
  type ShareViewer,
} from './session-share-identity';

function ShareThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  // The reader offers Light and Dark only, and starts Light. It deliberately
  // does not follow the app's appearance setting: a share is read on machines
  // that never signed in, so `system` here would be a preference nobody set.
  useEffect(() => {
    if (theme !== 'light' && theme !== 'dark') setTheme('light');
  }, [theme, setTheme]);
  const dark = theme === 'dark';
  const label = t('sharing.appearance', 'Appearance: {{mode}}', {
    mode: dark ? t('settings.theme.dark', 'Dark') : t('settings.theme.light', 'Light'),
  });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 text-muted-foreground"
      aria-label={label}
      aria-pressed={dark}
      title={label}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? (
        <Moon className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Sun className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

function ShareConversationPane({
  conversationId,
  title,
  tabs,
  onSelect,
  snapshot,
  attachmentAccess,
  showFork,
}: {
  conversationId: string;
  title: string;
  /** Sibling child Tabs of this pane, app-style. One entry renders as a solo tab. */
  tabs: { id: string; title: string }[];
  onSelect: (conversationId: string) => void;
  snapshot: SessionShareReaderSnapshot;
  attachmentAccess: ShareAttachmentAccess;
  /** Fork covers the whole share, so the side pane leaves it to the main one. */
  showFork?: boolean;
}) {
  const { t } = useTranslation();
  const [copying, setCopying] = useState(false);
  const cacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
  const stream = useMemo(
    () => buildChatStreamItems(snapshot.history, conversationId as SessionId, cacheRef.current),
    [snapshot.history, conversationId]
  );
  cacheRef.current = stream.cache;
  const attachments = useMemo(
    () => ({
      renderImage: (entry: Parameters<typeof SharedImage>[0]['entry']) => (
        <SharedImage key={entry.key} entry={entry} access={attachmentAccess} />
      ),
      renderFiles: (files: Parameters<typeof SharedFile>[0]['file'][]) => (
        <div className="space-y-2">
          {files.map((file) =>
            file.transport === 'r2' ? (
              <SharedFile key={file.fileId} file={file} access={attachmentAccess} />
            ) : (
              <SharedAttachmentUnavailable key={file.fileId} />
            )
          )}
        </div>
      ),
    }),
    [attachmentAccess]
  );
  const renderRow = useCallback(
    (
      args: Parameters<
        NonNullable<Parameters<typeof SessionChatStreamView>[0]['renderMessageRow']>
      >[0]
    ) => <MessageRowView {...args} user={null} />,
    []
  );
  const copy = async () => {
    if (copying || snapshot.status !== 'ready') return;
    setCopying(true);
    try {
      const history = conversationCopyRange(snapshot.history);
      const last = history.at(-1);
      const { markdown, stats } = buildConversationMarkdown({
        history: history as Parameters<typeof buildConversationMarkdown>[0]['history'],
        title,
        incompleteFinalResponse:
          last?.role === 'assistant' && !last.finished
            ? t(
                'sessions.copyContextIncomplete',
                'The last response was still generating when copied.'
              )
            : undefined,
      });
      await navigator.clipboard.writeText(markdown);
      toast.success(describeCopiedConversation(stats, t));
    } catch {
      toast.error(
        t('sessions.copyConversationHistoryFailed', 'Failed to copy conversation history')
      );
    } finally {
      setCopying(false);
    }
  };
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={title}>
      {/* The app names a conversation with its tab, not a second title bar, so
          a single conversation and a set of child Tabs read identically here. */}
      <h1 className="sr-only">{title}</h1>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {tabs.length > 1 ? (
          <TabPillStrip
            items={tabs.map((tab) => ({ key: tab.id, label: tab.title }))}
            activeKey={conversationId}
            onSelect={onSelect}
            ariaLabel={t('sharing.conversations', 'Shared conversations')}
            className="min-w-0 overflow-x-auto"
            itemClassName="max-w-56 shrink-0"
          />
        ) : (
          <span
            className={cn(
              'flex h-8 min-w-0 items-center rounded-md border border-transparent px-3 text-[13px] font-medium',
              TAB_PILL_ACTIVE_CLASS
            )}
          >
            <span className="min-w-0 truncate">{title}</span>
          </span>
        )}
      </div>
      {snapshot.status === 'unavailable' ? (
        <p role="status" className="p-8 text-sm text-muted-foreground">
          {t('sharing.unavailable', 'This share is unavailable')}
        </p>
      ) : (
        <>
          <SessionReadonlyContext.Provider value={attachments}>
            <SessionChatStreamView
              key={conversationId}
              sessionId={conversationId as SessionId}
              items={stream.items}
              className="min-h-0 flex-1"
              renderMessageRow={renderRow}
              lastAssistantMessageId={stream.lastAssistantMessageId}
              lastCompletedAssistantMessageId={stream.lastCompletedAssistantMessageId}
              emptyState={
                <p role="status" className="p-8 text-center text-sm text-muted-foreground">
                  {snapshot.status === 'loading'
                    ? t('sharing.loading', 'Loading shared conversation…')
                    : t('sharing.empty', 'No messages yet')}
                </p>
              }
            />
          </SessionReadonlyContext.Provider>
          <SessionShareComposer
            showFork={showFork}
            onCopyMarkdown={() => void copy()}
            copyDisabled={copying || snapshot.status !== 'ready'}
          />
        </>
      )}
    </section>
  );
}

const loadingSnapshot: SessionShareReaderSnapshot = { status: 'loading', history: [] };

export function SessionShareSurface(props: {
  manifest: SharePackageManifest | null;
  sessionId: string | null;
  status: 'loading' | 'unavailable' | 'ready';
  snapshot: SessionShareReaderSnapshot;
  onSelect: (conversationId: string) => void;
  attachmentAccess: ShareAttachmentAccess;
  /** Supplied by a host that can establish an identity; signed-out otherwise. */
  viewer?: ShareViewer;
  /**
   * Rendered inside the authenticated app (the publisher's frozen-copy
   * preview). Visitor chrome is suppressed: the theme control here would drive
   * the surrounding app's own appearance, and the sign-in slot describes a
   * visitor, not the publisher looking at their own package.
   */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const viewer = props.viewer ?? { status: 'signed-out' as const };
  const appOrigin = useMemo(() => resolveShareAppOrigin(), []);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [treeVisible, setTreeVisible] = useState(true);
  const { manifest, sessionId, status } = props;
  const tree = useMemo(() => {
    if (!manifest) return [];
    const byId = new Map(manifest.conversations.map((entry) => [entry.id, entry]));
    return buildOpenedBySessionTree(
      manifest.conversations.filter((entry) => !entry.parentConversationId),
      {
        getId: (entry) => entry.id,
        getOpenedBySessionId: (entry) => {
          const opener = entry.openedByConversationId
            ? byId.get(entry.openedByConversationId)
            : undefined;
          return opener?.parentConversationId ?? opener?.id;
        },
        isCollapsed: (id) => collapsed.has(id),
      }
    );
  }, [manifest, collapsed]);
  if (status === 'unavailable')
    return (
      <main className="flex min-h-dvh items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-medium">
            {t('sharing.unavailable', 'This share is unavailable')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('sharing.unavailableDetail', 'The link may be incomplete, reset, or revoked.')}
          </p>
        </div>
      </main>
    );
  if (!manifest || !sessionId)
    return (
      <main
        role="status"
        className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground"
      >
        {t('sharing.loading', 'Loading shared conversation…')}
      </main>
    );
  const panes = resolveSharePanes(manifest, sessionId);
  const hasTree = manifest.conversations.filter((entry) => !entry.parentConversationId).length > 1;
  const title = (value: string) => value || t('sharing.defaultTitle', 'Shared conversation');
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <ShareBrandLink appOrigin={appOrigin} />
          {hasTree && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-expanded={treeVisible}
              aria-label={t('sharing.toggleTree', 'Toggle conversation tree')}
              onClick={() => setTreeVisible((value) => !value)}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!props.embedded && (
            <>
              <ShareThemeToggle />
              <ShareViewerIdentity viewer={viewer} appOrigin={appOrigin} />
            </>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {hasTree && treeVisible && (
          <nav
            aria-label={t('sharing.conversationTree', 'Conversation tree')}
            className="max-h-40 shrink-0 overflow-auto border-b border-border bg-muted/20 p-2 sm:max-h-none sm:w-56 sm:border-b-0 sm:border-r"
          >
            {tree.map((node) => (
              <div
                key={node.id}
                className={`flex items-center rounded-md ${node.id === panes.root.id ? 'bg-accent' : 'hover:bg-accent/50'}`}
              >
                <SessionRowLeadingSlot
                  menuLabel=""
                  openedByTree={buildSessionRowOpenedByTreeSlot(node, t, () =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  )}
                />
                <button
                  type="button"
                  onClick={() => props.onSelect(node.id)}
                  aria-current={node.id === panes.root.id ? 'page' : undefined}
                  className="min-w-0 flex-1 truncate px-2 py-2 text-left text-[13px]"
                >
                  {title(node.item.title)}
                </button>
              </div>
            ))}
          </nav>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ShareConversationPane
            key={panes.main.id}
            conversationId={panes.main.id}
            title={title(panes.main.title)}
            tabs={panes.tabs.map((tab) => ({ id: tab.id, title: title(tab.title) }))}
            onSelect={props.onSelect}
            snapshot={props.snapshot}
            attachmentAccess={props.attachmentAccess}
          />
        </div>
      </div>
    </main>
  );
}

type SessionSharePageProps = { apiOrigin: string; shareId: string; secret: string | null };

export function SessionSharePage(props: SessionSharePageProps) {
  const [identity, setIdentity] = useState({ ...props, epoch: 0 });
  if (
    identity.apiOrigin !== props.apiOrigin ||
    identity.shareId !== props.shareId ||
    identity.secret !== props.secret
  ) {
    setIdentity({ ...props, epoch: identity.epoch + 1 });
  }
  // An identity/credential change immediately unmounts old transcripts and aborts reads.
  return (
    <SessionShareErrorBoundary key={identity.epoch}>
      <SessionShareReaderPage {...props} />
    </SessionShareErrorBoundary>
  );
}

function useShareConversation(share: StaticShare | null, conversationId: string | undefined) {
  const [state, setState] = useState<{
    share: StaticShare;
    id: string;
    snapshot: SessionShareReaderSnapshot;
  } | null>(null);
  useEffect(() => {
    if (!share || !conversationId) return undefined;
    const reader = createSessionShareReader({
      share,
      conversationId,
      onChange: (snapshot) => setState({ share, id: conversationId, snapshot }),
    });
    void reader.start();
    return () => reader.close();
  }, [share, conversationId]);
  return state?.share === share && state?.id === conversationId ? state.snapshot : loadingSnapshot;
}

function SessionShareReaderPage({ apiOrigin, shareId, secret }: SessionSharePageProps) {
  const [share, setShare] = useState<StaticShare | null>(null);
  const [failed, setFailed] = useState(!secret);
  const search = useSyncExternalStore(
    subscribeSessionShareNavigation,
    getSessionShareSearch,
    () => ''
  );
  useEffect(() => {
    if (!secret) return undefined;
    const lifetime = new AbortController();
    void openStaticShare({ origin: apiOrigin, shareId, secret, signal: lifetime.signal })
      .then((value) => {
        if (!lifetime.signal.aborted) setShare(value);
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setFailed(true);
      });
    return () => lifetime.abort();
  }, [apiOrigin, shareId, secret]);
  const sessionId = resolveSessionShareTab(share?.manifest ?? null, search);
  const panes = share && sessionId ? resolveSharePanes(share.manifest, sessionId) : null;
  const snapshot = useShareConversation(share, panes?.main.id);
  const access = useMemo<ShareAttachmentAccess>(
    () => ({
      async read(id, signal) {
        if (!share) throw new Error('Share unavailable');
        const attachment = await share.readAttachment(id, signal);
        return new Blob([attachment.bytes.slice().buffer], { type: attachment.mediaType });
      },
    }),
    [share]
  );
  return (
    <SessionShareSurface
      manifest={share?.manifest ?? null}
      sessionId={sessionId}
      status={failed ? 'unavailable' : share ? 'ready' : 'loading'}
      snapshot={snapshot}
      attachmentAccess={access}
      onSelect={(id) => {
        if (share?.manifest.conversations.some((entry) => entry.id === id))
          navigateSessionShareTab(id);
      }}
    />
  );
}
