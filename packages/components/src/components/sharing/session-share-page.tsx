import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { SessionId } from '@lody/shared';
import {
  SessionShareManifestSchema,
  type SessionShareManifest,
} from '@lody/shared/session-sharing';
import {
  createSessionShareReader,
  type SessionShareReaderSnapshot,
} from '@/lib/session-share-reader';
import { fetchSessionShare } from '@/lib/session-share-fetch';
import {
  getSessionShareSearch,
  navigateSessionShareTab,
  resolveSessionShareTab,
  subscribeSessionShareNavigation,
} from '@/lib/session-share-navigation';
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
import { nextCycledTheme, useTheme } from '@/theme-provider';

/**
 * The reader's only control. It reuses the app's ThemeProvider — the same
 * light/dark/system cycle, resolution and cached selection — instead of a
 * reader-specific mode, so a visitor who already chose a theme on this origin
 * keeps it. localStorage is per-origin: a choice made on the app's domain
 * cannot be read from the share domain, and each origin remembers its own.
 */
function ShareThemeToggle() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const mode =
    theme === 'light'
      ? t('settings.theme.light', 'Light')
      : theme === 'dark'
        ? t('settings.theme.dark', 'Dark')
        : t('settings.theme.system', 'System');
  const label = t('sharing.appearance', 'Appearance: {{mode}}', { mode });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 text-muted-foreground"
      aria-label={label}
      title={label}
      onClick={() => setTheme(nextCycledTheme(theme))}
    >
      {theme === 'light' ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : theme === 'dark' ? (
        <Moon className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Monitor className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

export function SessionShareSurface(props: {
  manifest: SessionShareManifest | null;
  sessionId: string | null;
  status: 'loading' | 'unavailable' | 'paused' | 'ready';
  snapshot: SessionShareReaderSnapshot;
  onSelect: (sessionId: string) => void;
  attachmentAccess: ShareAttachmentAccess;
}) {
  const { t } = useTranslation();
  const { manifest, sessionId, status, snapshot } = props;
  const cacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
  const stream = useMemo(
    () => buildChatStreamItems(snapshot.history, (sessionId ?? '') as SessionId, cacheRef.current),
    [snapshot.history, sessionId]
  );
  cacheRef.current = stream.cache;
  const attachments = useMemo(
    () => ({
      renderImage: (entry: Parameters<typeof SharedImage>[0]['entry']) => (
        <SharedImage key={entry.key} entry={entry} access={props.attachmentAccess} />
      ),
      renderFiles: (files: Parameters<typeof SharedFile>[0]['file'][]) => (
        <div className="space-y-2">
          {files.map((file) =>
            file.transport === 'r2' ? (
              <SharedFile key={file.fileId} file={file} access={props.attachmentAccess} />
            ) : (
              <SharedAttachmentUnavailable key={file.fileId} />
            )
          )}
        </div>
      ),
    }),
    [props.attachmentAccess]
  );
  const renderRow = useCallback(
    (
      args: Parameters<
        NonNullable<Parameters<typeof SessionChatStreamView>[0]['renderMessageRow']>
      >[0]
    ) => <MessageRowView {...args} user={null} />,
    []
  );
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
  if (!manifest || sessionId === null || sessionId === '')
    return (
      <main
        className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        {status === 'paused'
          ? t('sharing.paused', 'Updates paused · Reconnecting…')
          : t('sharing.loading', 'Loading shared conversation…')}
      </main>
    );
  const storedTitle =
    manifest.targets.find((target) => target.sessionId === sessionId)?.title ?? '';
  const title =
    storedTitle.length > 0 ? storedTitle : t('sharing.defaultTitle', 'Shared conversation');
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
        <div className="mx-auto max-w-5xl">
          {/* Visitor context sits on the workspace line so the conversation title
              always owns a full-width line, including on a narrow phone. */}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {manifest.workspaceName}
            </p>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {t('sharing.anonymous', 'Anonymous visitor')}
            </span>
            <ShareThemeToggle />
          </div>
          <h1 className="truncate text-[0.9375rem] font-medium leading-6">{title}</h1>
          {/* Only interruptions are announced. A steady live read-only view is the
              page's normal state and says so through its own absence of controls. */}
          <div
            className="text-xs text-muted-foreground empty:hidden [&:not(:empty)]:mt-1.5"
            role="status"
          >
            {status === 'paused' || snapshot.status === 'paused'
              ? t('sharing.paused', 'Updates paused · Reconnecting…')
              : snapshot.status === 'loading'
                ? t('sharing.loading', 'Loading shared conversation…')
                : ''}
          </div>
          {manifest.targets.length > 1 && (
            <nav
              // Negative inset lets the first target's label sit on the same
              // optical line as the title above it.
              className="-mx-2.5 -mb-0.5 mt-1.5 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label={t('sharing.conversations', 'Shared conversations')}
            >
              {manifest.targets.map((target) => (
                <button
                  type="button"
                  key={target.sessionId}
                  aria-current={target.sessionId === sessionId ? 'page' : undefined}
                  onClick={() => props.onSelect(target.sessionId)}
                  // Capped so a second target always peeks in: the row has to read
                  // as navigation, not as a repeat of the heading above it.
                  className={`max-w-[45%] shrink-0 truncate rounded-md px-2.5 py-1 text-[0.8125rem] sm:max-w-[16rem] ${target.sessionId === sessionId ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
                >
                  {target.title || t('sharing.defaultTitle', 'Shared conversation')}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>
      <SessionReadonlyContext.Provider value={attachments}>
        <SessionChatStreamView
          key={sessionId}
          sessionId={sessionId as SessionId}
          items={stream.items}
          className="min-h-0 flex-1"
          renderMessageRow={renderRow}
          lastAssistantMessageId={stream.lastAssistantMessageId}
          lastCompletedAssistantMessageId={stream.lastCompletedAssistantMessageId}
          emptyState={
            <p className="p-8 text-center text-sm text-muted-foreground">
              {snapshot.status === 'loading'
                ? t('sharing.loading', 'Loading shared conversation…')
                : t('sharing.empty', 'No messages yet')}
            </p>
          }
        />
      </SessionReadonlyContext.Provider>
    </main>
  );
}

type SessionSharePageProps = { apiOrigin: string; shareId: string; secret: string | null };

export function SessionSharePage(props: SessionSharePageProps) {
  return (
    <SessionShareErrorBoundary>
      <SessionShareReaderPage {...props} />
    </SessionShareErrorBoundary>
  );
}

function SessionShareReaderPage({ apiOrigin, shareId, secret }: SessionSharePageProps) {
  const [manifest, setManifest] = useState<SessionShareManifest | null>(null);
  const search = useSyncExternalStore(
    subscribeSessionShareNavigation,
    getSessionShareSearch,
    () => ''
  );
  const sessionId = resolveSessionShareTab(manifest, search);
  const rootSessionId = manifest?.rootSessionId ?? null;
  const [status, setStatus] = useState<'loading' | 'unavailable' | 'paused' | 'ready'>(
    secret !== null && secret.length > 0 ? 'loading' : 'unavailable'
  );
  const [readerState, setReaderState] = useState<{
    sessionId: string;
    snapshot: SessionShareReaderSnapshot;
  } | null>(null);
  // A tab switch is visible before passive effect cleanup. Never render the
  // previous transcript or attachment references under the new target's title.
  const snapshot: SessionShareReaderSnapshot =
    readerState?.sessionId === sessionId
      ? readerState.snapshot
      : { status: 'loading', history: [] };
  const [refreshKey, setRefreshKey] = useState(0);
  const unavailable = status === 'unavailable';
  const base = `${apiOrigin.replace(/\/$/, '')}/api/shares/${encodeURIComponent(shareId)}`;
  useEffect(() => {
    if (secret === null || secret === '') return undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const response = await fetchSessionShare(
          base,
          {
            headers: { Authorization: `Bearer ${secret}` },
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(15_000),
          },
          abort.signal
        );
        if (abort.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          setStatus('unavailable');
          setManifest(null);
          setReaderState(null);
          return;
        }
        if (!response.ok) throw new Error('Unavailable');
        const value = SessionShareManifestSchema.parse(await response.json());
        if (
          value.shareId !== shareId ||
          value.validUntil <= Date.now() ||
          !value.targets.some((target) => target.sessionId === value.rootSessionId)
        )
          throw new Error('Invalid manifest');
        if (abort.signal.aborted) return;
        setManifest(value);
        setStatus('ready');
      } catch {
        if (!abort.signal.aborted) setStatus('paused');
      }
      if (!abort.signal.aborted)
        timer = setTimeout(() => {
          void refresh();
        }, 30_000);
    };
    void refresh();
    return () => {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [base, secret, shareId, refreshKey]);
  useEffect(() => {
    if (sessionId === null || sessionId === '' || secret === null || secret === '' || unavailable)
      return undefined;
    let active = true;
    setReaderState({ sessionId, snapshot: { status: 'loading', history: [] } });
    const reader = createSessionShareReader({
      streamUrl: `${base}/sessions/${encodeURIComponent(sessionId)}/stream`,
      secret,
      onChange(value) {
        if (!active) return;
        setReaderState({ sessionId, snapshot: value });
        if (value.status === 'unavailable') {
          setReaderState(null);
          if (sessionId === rootSessionId) {
            setStatus('unavailable');
            setManifest(null);
          } else if (rootSessionId !== null) {
            // An individual child may have lost access while the root survives.
            navigateSessionShareTab(rootSessionId, true);
            setRefreshKey((key) => key + 1);
          }
        }
      },
    });
    void reader.start().catch(() => {
      if (active)
        setReaderState((value) => ({
          sessionId,
          snapshot: {
            history: value?.sessionId === sessionId ? value.snapshot.history : [],
            status: 'paused',
          },
        }));
    });
    return () => {
      active = false;
      void reader.close();
    };
  }, [base, secret, sessionId, unavailable, rootSessionId]);
  const targetAvailable =
    status !== 'unavailable' &&
    (manifest?.targets.some((target) => target.sessionId === sessionId) ?? false);
  const access = useMemo<ShareAttachmentAccess>(
    () => ({
      async read(resource, signal, range, storageSessionId) {
        if (
          secret === null ||
          secret === '' ||
          sessionId === null ||
          sessionId === '' ||
          !targetAvailable
        )
          throw new Error('Unavailable');
        const url = new URL(`${base}/sessions/${encodeURIComponent(sessionId)}/${resource}`);
        if (storageSessionId !== undefined && storageSessionId !== sessionId)
          url.searchParams.set('storageSessionId', storageSessionId);
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${secret}`,
            ...(range !== undefined && range.length > 0 ? { Range: range } : {}),
          },
          signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Attachment unavailable');
        return response;
      },
    }),
    [base, secret, sessionId, targetAvailable]
  );
  return (
    <SessionShareSurface
      manifest={manifest}
      sessionId={sessionId}
      status={status}
      snapshot={snapshot}
      onSelect={(target) => {
        if (manifest?.targets.some((entry) => entry.sessionId === target) === true)
          navigateSessionShareTab(target);
      }}
      attachmentAccess={access}
    />
  );
}
