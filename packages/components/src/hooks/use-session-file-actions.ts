import { useCallback, useMemo, type ComponentType, type SVGProps } from 'react';
import { useAtomValue } from 'jotai';
import { Copy, Download, ExternalLink, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  getMachineFlockLocalProjects,
  type CodeCollabContentUnavailableReason,
  type SessionMeta,
} from '@lody/shared';
import { getMachineMetaByIdAtomFamily } from '@/atoms';
import { localHomeDirAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { writeTextToClipboard } from '@/lib/clipboard';
import { downloadBytesAsFile } from '@/lib/download-file';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { FileWorkspaceOpenResult } from '@/lib/file-workspace-provider';
import {
  normalizeSessionFileActionPlatform,
  resolveOpenFileLabel,
  resolveOpenFileTarget,
  resolveRevealFileLabel,
  resolveSessionFileActionAvailability,
  type SessionFileErrorActions,
} from '@/lib/session-file-actions';
import { resolveLocalWorkspaceFilePath } from '@/lib/session-local-file-path';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import {
  buildPathLauncherLaunchInput,
  getAvailablePathLauncherOptions,
  readStoredPathLauncherPreference,
  resolveSelectedPathLauncher,
} from '@/lib/session-path-launchers';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';

export type SessionFileLocalHostActionSet = {
  readonly revealLabel: string;
  readonly reveal: (filePath: string) => void;
  readonly openLabel: (filePath: string) => string;
  readonly openInDefaultApp: (filePath: string) => void;
  /** The editor the user picked for "Open in"; null when none is available. */
  readonly editor: { readonly label: string; readonly open: (filePath: string) => void } | null;
};

export type SessionFileMenuItemId = 'copy-path' | 'open-in-editor' | 'reveal' | 'download';

export type SessionFileMenuItem = {
  readonly id: SessionFileMenuItemId;
  readonly label: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement> & { size?: string | number }>;
  readonly run: (filePath: string) => void;
};

export type SessionFileActions = {
  /** Absolute path on the machine that owns the file, when it resolves. */
  readonly resolveHostPath: (filePath: string) => string | null;
  readonly copyPath: (filePath: string) => void;
  /** Non-null only in the desktop app with the file on this machine. */
  readonly localHost: SessionFileLocalHostActionSet | null;
  /** The remote stand-in for the local-host actions. */
  readonly download: ((filePath: string) => void) | null;
  /** The subset the file-error card renders, or undefined with nothing to offer. */
  readonly buildErrorActions: (filePath: string) => SessionFileErrorActions | undefined;
  /**
   * The same actions as a menu, for the file tree's context menu and the side
   * panel's ⋯ menu. Stable across renders so a memoized tree row can take it.
   */
  readonly menuItems: readonly SessionFileMenuItem[];
};

/**
 * One resolver for "what can this client do with this session's files", shared
 * by the file tree context menu, the side panel ⋯ menu, and the file error
 * card. See `lib/session-file-actions.ts` for the local-host / remote split it
 * enforces; every surface renders what this returns and never re-derives it.
 */
export function useSessionFileActions({
  session,
  fileProvider,
}: {
  /** Null while the surface has no session yet; every action is then absent. */
  readonly session: SessionMeta | null | undefined;
  /**
   * Only `openFile` is used (for the remote download), so both the file
   * workspace and session provider shapes fit.
   */
  readonly fileProvider?: {
    openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult>;
  } | null;
}): SessionFileActions {
  const { t } = useTranslation();
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localHomeDir = useAtomValue(localHomeDirAtom);
  const sessionMachine = useAtomValue(
    getMachineMetaByIdAtomFamily(session?.machineId ?? undefined)
  );
  const machineFlockRows = useMachineFlockRows(session?.machineId ?? null, {
    // `dotlodyPath` is what turns a worktree session into an absolute path.
    families: ['localProject', 'dotlodyPath'],
  });

  const isElectronRenderer = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const isLocalMachine = Boolean(localMachineId) && session?.machineId === localMachineId;
  const platform = normalizeSessionFileActionPlatform(
    typeof window === 'undefined' ? undefined : window.__LODY_PLATFORM__?.os
  );

  const localProjectRootPath = useMemo(
    () =>
      session
        ? resolveSessionLocalProjectRootPath(session, {
            ...(sessionMachine?.localProjects ?? {}),
            ...getMachineFlockLocalProjects(machineFlockRows),
          })
        : null,
    [machineFlockRows, session, sessionMachine?.localProjects]
  );
  const machineDotlodyPath = useMemo(
    () => resolveMachineDotlodyPath(machineFlockRows, isLocalMachine ? localHomeDir : null),
    [isLocalMachine, localHomeDir, machineFlockRows]
  );
  const workspacePath = useMemo(
    () =>
      !session
        ? null
        : resolveSessionWorkspacePath({
            sessionId: session.id,
            ownerSessionId: session.parentSessionId,
            isWorktree: session.isWorktree,
            dotlodyPath: machineDotlodyPath,
            localProjectRootPath,
            repoFullName: resolveSessionRepoFullName(session),
            legacyWorkspacePath: sessionMachine?.workspacePaths?.[session.id],
          }),
    [localProjectRootPath, machineDotlodyPath, session, sessionMachine?.workspacePaths]
  );

  const resolveHostPath = useCallback(
    (filePath: string) => resolveLocalWorkspaceFilePath(workspacePath, filePath),
    [workspacePath]
  );

  const reportOpenFailure = useCallback(
    (missing: boolean) => {
      toast.error(
        missing
          ? t('sessions.fileActions.fileMissing', 'That file no longer exists.')
          : t('sessions.fileActions.openFailed', 'Could not open that file.')
      );
    },
    [t]
  );

  const copyPath = useCallback(
    (filePath: string) => {
      // The machine path is what the user asked for; the workspace-relative
      // path is what remains when that machine's rows have not synced.
      const target = resolveHostPath(filePath) ?? filePath.trim();
      if (!target) return;
      void (async () => {
        const copied = await writeTextToClipboard(target);
        if (copied) {
          toast.success(t('sessions.fileViewer.pathCopied', 'File path copied'));
        } else {
          toast.error(t('sessions.fileViewer.pathCopyFailed', 'Failed to copy file path'));
        }
      })();
    },
    [resolveHostPath, t]
  );

  // Read once per render rather than subscribed: the menus mount on demand, so
  // they already pick up a preference changed in settings since the last open.
  const editorLauncher = useMemo(() => {
    if (!isElectronRenderer) return null;
    const preference = readStoredPathLauncherPreference();
    const options = getAvailablePathLauncherOptions({
      customLaunchers: preference.customLaunchers,
      isElectron: true,
      platform,
    });
    return resolveSelectedPathLauncher(preference.selectedLauncherId, options);
  }, [isElectronRenderer, platform]);

  // ONE decision for both halves, and `hasHostPath` is the real thing: an
  // Electron renderer on the owning machine still cannot reach a shell until
  // that machine's path metadata resolves. Deriving it from `localHost` was
  // circular — it offered editor/reveal actions that could only fail while the
  // rows loaded, and hid the download that would have worked.
  const availability = useMemo(
    () =>
      resolveSessionFileActionAvailability({
        isElectronRenderer,
        isLocalMachine,
        hasHostPath: workspacePath !== null,
        hasFileProvider: Boolean(fileProvider),
      }),
    [fileProvider, isElectronRenderer, isLocalMachine, workspacePath]
  );

  const localHost = useMemo<SessionFileLocalHostActionSet | null>(() => {
    if (!session || !availability.localHost) return null;

    const withHostPath = (filePath: string, run: (path: string) => void) => {
      const path = resolveHostPath(filePath);
      if (!path) {
        reportOpenFailure(false);
        return;
      }
      run(path);
    };

    return {
      revealLabel: resolveRevealFileLabel(platform, t),
      openLabel: (filePath: string) => resolveOpenFileLabel(filePath, t),
      reveal: (filePath) =>
        withHostPath(filePath, (path) => {
          void (async () => {
            const result = await getIpcServices()?.app.revealLocalPath(path);
            if (result && !result.revealed) reportOpenFailure(result.error === 'not_found');
          })();
        }),
      openInDefaultApp: (filePath) =>
        withHostPath(filePath, (path) => {
          void (async () => {
            const result = await getIpcServices()?.app.openLocalPath(path);
            if (result && !result.opened) reportOpenFailure(result.error === 'not_found');
          })();
        }),
      editor: editorLauncher
        ? {
            label: t('sessions.fileActions.openInEditor', 'Open in {{editor}}', {
              editor: editorLauncher.label,
            }),
            open: (filePath) =>
              withHostPath(filePath, (path) => {
                void (async () => {
                  const services = getIpcServices();
                  if (!services) return;
                  const result = await services.app.launchLocalPath(
                    buildPathLauncherLaunchInput(editorLauncher, path, platform)
                  );
                  if (!result.launched) {
                    toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
                  }
                })();
              }),
          }
        : null,
    };
  }, [
    availability.localHost,
    editorLauncher,
    platform,
    reportOpenFailure,
    resolveHostPath,
    session,
    t,
  ]);

  const download = useMemo(() => {
    if (!session || !availability.download || !fileProvider) return null;

    // KNOWN CEILING: this reads through the preview API, which answers in ONE
    // bounded response (10 MiB text / 5 MiB binary remotely). So the download
    // covers ordinary files and cannot cover the oversized ones — the very
    // files whose error card sent the user looking for a way out. Saying that
    // is the point of `downloadTooLarge`: a generic "could not download" reads
    // as a glitch worth retrying. A real answer for those needs a ranged or
    // streamed transfer, which is a Machine RPC protocol change (new method
    // plus a negotiated `protocolCapabilities` key, never inferred from the CLI
    // version) rather than a client-side fix.
    const reportUnavailable = (reason: CodeCollabContentUnavailableReason | 'no-bytes') => {
      if (reason === 'deleted') {
        toast.error(t('sessions.fileActions.fileMissing', 'That file no longer exists.'));
        return;
      }
      if (reason === 'text-too-large' || reason === 'blob-too-large' || reason === 'no-bytes') {
        toast.error(
          t(
            'sessions.fileActions.downloadTooLarge',
            'This file is too large to download from here. Open it on the machine that owns it.'
          )
        );
        return;
      }
      toast.error(t('sessions.fileActions.downloadFailed', 'Could not download that file.'));
    };

    return (filePath: string) => {
      void (async () => {
        try {
          const result = await fileProvider.openFile(filePath);
          if (result.status !== 'ready') {
            reportUnavailable(result.reason);
            return;
          }
          const snapshot = result.snapshot;
          if (snapshot.kind === 'text') {
            downloadBytesAsFile(filePath, new TextEncoder().encode(snapshot.text));
            return;
          }
          if (snapshot.kind === 'binary' && snapshot.bytes) {
            downloadBytesAsFile(filePath, snapshot.bytes);
            return;
          }
          // A `binary` snapshot with no bytes is the machine declining to send
          // them, which is the same "too big for one response" situation.
          reportUnavailable('no-bytes');
        } catch {
          toast.error(t('sessions.fileActions.downloadFailed', 'Could not download that file.'));
        }
      })();
    };
  }, [availability.download, fileProvider, session, t]);

  const buildErrorActions = useCallback(
    (filePath: string): SessionFileErrorActions | undefined => {
      const trimmed = filePath.trim();
      if (!session || !trimmed) return undefined;
      const onCopyPath = () => copyPath(trimmed);
      if (!localHost || !resolveHostPath(trimmed)) return { onCopyPath };
      return {
        onCopyPath,
        localHost: {
          openTarget: resolveOpenFileTarget(trimmed),
          revealLabel: localHost.revealLabel,
          onOpen: () => localHost.openInDefaultApp(trimmed),
          onReveal: () => localHost.reveal(trimmed),
        },
      };
    },
    [copyPath, localHost, resolveHostPath, session]
  );

  const menuItems = useMemo<readonly SessionFileMenuItem[]>(() => {
    if (!session) return [];
    const items: SessionFileMenuItem[] = [
      {
        id: 'copy-path',
        label: t('sessions.fileViewer.copyPath', 'Copy file path'),
        icon: Copy,
        run: copyPath,
      },
    ];
    if (localHost?.editor) {
      const editor = localHost.editor;
      items.push({
        id: 'open-in-editor',
        label: editor.label,
        icon: ExternalLink,
        run: editor.open,
      });
    }
    if (localHost) {
      items.push({
        id: 'reveal',
        label: localHost.revealLabel,
        icon: FolderOpen,
        run: localHost.reveal,
      });
    }
    if (download) {
      items.push({
        id: 'download',
        label: t('sessions.fileActions.download', 'Download file'),
        icon: Download,
        run: download,
      });
    }
    return items;
  }, [copyPath, download, localHost, session, t]);

  return { resolveHostPath, copyPath, localHost, download, buildErrorActions, menuItems };
}
