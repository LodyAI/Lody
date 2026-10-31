import { useCallback, useEffect, useMemo, type ComponentProps } from 'react';
import { useAtomValue } from 'jotai';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, Copy, Ellipsis } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import {
  buildConversationMarkdown,
  getSessionRoomId,
  resolveProjectGitHubRepo,
  resolveSessionHistoryBackendKind,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { childSessionsAtomFamily, sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationVersion } from '@/hooks/use-conversation-view';
import { usePlaintextCopy } from '@/hooks/use-plaintext-copy';
import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { readConversationCopySource } from '@/lib/conversation-copy-source';
import { describeCopiedConversation } from '@/lib/describe-copied-conversation';
import { toast } from '@/lib/toast';
import SessionChatStream from '../ai-gui';
import { WorkspaceUserImageBlock, WorkspaceSessionFileGroup } from '../ai-gui/view';
import { SessionReadonlyContext } from '../ai-gui/session-readonly-context';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
    minHeight: `calc(${space[6]} * 2)`,
    boxSizing: 'border-box',
    paddingBlock: space[2],
    paddingInline: space[3],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  nativeHeader: {
    paddingTop: `calc(${space[2]} + var(--safe-area-top, 0px))`,
    paddingLeft: `calc(${space[3]} + var(--safe-area-left, 0px))`,
    paddingRight: `calc(${space[3]} + var(--safe-area-right, 0px))`,
  },
  trafficLightInset: { paddingLeft: `calc(${space[8]} * 2 + ${space[4]})` },
  title: {
    margin: 0,
    minWidth: 0,
    flexGrow: 1,
    fontSize: text.bodySize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  notice: {
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
  },
  stream: { flexGrow: 1, minHeight: 0 },
});
const attachments = {
  renderImage: (entry: ComponentProps<typeof WorkspaceUserImageBlock>['entry']) => (
    <WorkspaceUserImageBlock entry={entry} />
  ),
  renderFiles: (
    files: ComponentProps<typeof WorkspaceSessionFileGroup>['files'],
    sessionId: SessionId
  ) => <WorkspaceSessionFileGroup files={files} sessionId={sessionId} />,
};

/** Existing document/attachment readers only; no composer, machine catalogs or RPC hooks. */
export function SessionHistoryView({
  sessionId,
  title,
  history,
  ready,
  onCopy,
  onBack,
  conversations,
  onSelect,
  nativeApp = false,
  reserveMacTrafficLightInset = false,
  requiresMachine = false,
}: {
  sessionId: SessionId;
  title: string;
  history: ComponentProps<typeof SessionChatStream>['view'];
  ready: boolean;
  onCopy?: () => void;
  onBack?: () => void;
  conversations?: readonly SessionMeta[];
  onSelect?: (id: SessionId) => void;
  nativeApp?: boolean;
  reserveMacTrafficLightInset?: boolean;
  requiresMachine?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section {...stylex.props(styles.page)}>
      <header
        {...stylex.props(
          styles.header,
          nativeApp && styles.nativeHeader,
          reserveMacTrafficLightInset && styles.trafficLightInset
        )}
      >
        {onBack && (
          <Button variant="ghost" icon aria-label={t('common.back')} onClick={onBack}>
            <ArrowLeft />
          </Button>
        )}
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button variant="ghost" icon aria-label={t('sessions.moreActions')}>
                <Ellipsis />
              </Button>
            }
          />
          <Menu.Content align="end">
            {conversations && conversations.length > 1 && onSelect && (
              <Menu.Submenu>
                <Menu.SubmenuTrigger>{t('sessions.historyConversations')}</Menu.SubmenuTrigger>
                <Menu.Content>
                  {conversations.map((item) => (
                    <Menu.Item key={item.id} onClick={() => onSelect(item.id)}>
                      {item.title || t('sessions.untitled')}
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Submenu>
            )}
            <Menu.Submenu>
              <Menu.SubmenuTrigger icon={Copy}>{t('sessions.copy')}</Menu.SubmenuTrigger>
              <Menu.Content>
                <Menu.Item icon={Copy} disabled={!onCopy || !ready} onClick={onCopy}>
                  {t('sessions.copyAsMarkdown')}
                </Menu.Item>
              </Menu.Content>
            </Menu.Submenu>
          </Menu.Content>
        </Menu.Root>
      </header>
      <p role="status" {...stylex.props(styles.notice)}>
        {t('sessions.historyMachineUnavailable')}
      </p>
      {ready && (
        <span
          hidden
          data-window-session-ready={sessionId}
          data-window-requires-stream={history?.turnCount ? 'true' : undefined}
        />
      )}
      {requiresMachine ? (
        <p role="status" {...stylex.props(styles.notice)}>
          {t('sessions.historyRequiresMachine')}
        </p>
      ) : (
        <SessionReadonlyContext.Provider value={attachments}>
          <SessionChatStream
            key={sessionId}
            sessionId={sessionId}
            view={history}
            className={stylex.props(styles.stream).className}
            emptyState={
              <p {...stylex.props(styles.notice)}>
                {ready ? t('sharing.empty') : t('common.loading')}
              </p>
            }
          />
        </SessionReadonlyContext.Provider>
      )}
    </section>
  );
}

export function SessionHistoryReader({
  rootSessionId,
  sessionId,
  onMobileBack,
  onMobilePresented,
}: {
  rootSessionId: SessionId;
  sessionId: SessionId;
  onMobileBack?: () => void;
  onMobilePresented?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const fullscreen = useElectronFullscreen();
  const nativeApp = isNativeAppShell();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const rootMeta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(rootSessionId)));
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const children = useAtomValue(childSessionsAtomFamily(rootSessionId));
  const backend = meta ? resolveSessionHistoryBackendKind(meta) : null;
  // Machine-owned history readers must never be opened by this document-only surface.
  const { history, ready, synced } = useSessionDoc(sessionId, { enabled: backend === 'loro' });
  const ownedHistory = runtime?.peekSessionStore?.(sessionId)?.history === history ? history : null;
  const historyReady = ready && ownedHistory !== null && (ownedHistory.turnCount > 0 || synced);
  useConversationVersion(ownedHistory);
  const exportAllowed = useWorkspaceFeature('export');
  const { run, confirmation } = usePlaintextCopy(runtime, sessionId, exportAllowed);
  useEffect(() => {
    if (historyReady) onMobilePresented?.(rootSessionId);
  }, [onMobilePresented, historyReady, rootSessionId]);
  const conversations = useMemo(
    () => (rootMeta ? [rootMeta, ...children] : children),
    [rootMeta, children]
  );
  const copy = useCallback(() => {
    if (!runtime || !ownedHistory?.turnCount || !historyReady || !exportAllowed) return;
    void run(async (assertCurrent, admitOutput) => {
      const messages = await readConversationCopySource(runtime, sessionId, ownedHistory);
      assertCurrent();
      const source =
        [resolveProjectGitHubRepo(meta?.project) ?? meta?.repoFullName, meta?.branchName]
          .filter(Boolean)
          .join(' · ') || undefined;
      const last = messages.at(-1);
      const { markdown, stats } = buildConversationMarkdown({
        workspaceId: runtime.workspaceId,
        history: messages,
        title: meta?.title,
        source,
        incompleteFinalResponse:
          last?.role === 'assistant' && !last.finished
            ? t('sessions.copyContextIncomplete')
            : undefined,
      });
      await admitOutput();
      assertCurrent();
      await navigator.clipboard.writeText(markdown);
      assertCurrent();
      toast.success(describeCopiedConversation(stats, t));
    }).catch(() => toast.error(t('sessions.copyConversationHistoryFailed')));
  }, [runtime, ownedHistory, historyReady, exportAllowed, run, sessionId, meta, t]);
  return (
    <>
      <SessionHistoryView
        sessionId={sessionId}
        title={meta?.title || t('sessions.untitled')}
        history={ownedHistory}
        ready={historyReady}
        onCopy={exportAllowed && historyReady && ownedHistory?.turnCount ? copy : undefined}
        requiresMachine={backend === 'roost'}
        onBack={onMobileBack}
        nativeApp={nativeApp}
        reserveMacTrafficLightInset={!nativeApp && isMacOSElectronRenderer() && !fullscreen}
        conversations={conversations}
        onSelect={(id) => {
          if (runtime)
            void router.navigate({
              to: '/$workspaceName/sessions/$sessionId',
              params: { workspaceName: runtime.workspaceSlug, sessionId: rootSessionId },
              search: id === rootSessionId ? {} : { tab: id },
            });
        }}
      />
      {confirmation}
    </>
  );
}
