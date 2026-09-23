import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react';
import { useAtomValue } from 'jotai';
import { Copy, Download, ExternalLink, FolderOpen, Share2 } from 'lucide-react';
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
import { downloadBytesAsFile, getDownloadFileName } from '@/lib/download-file';
import { isNativeAppShell } from '@/lib/native-platform';
import { shareFileBytesNatively } from '@/lib/session-file-native-save';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type {
  FileWorkspaceBinarySnapshot,
  FileWorkspaceOpenResult,
} from '@/lib/file-workspace-provider';
import {
  normalizeSessionFileActionPlatform,
  resolveOpenFileLabel,
  resolveOpenFileTarget,
  resolveRevealFileLabel,
  resolveSessionFileActionAvailability,
  type SessionFileErrorActions,
} from '@/lib/session-file-actions';
import { resolveLocalWorkspaceFilePath } from '@/lib/session-local-file-path';
import { resolveSessionFileOpenTarget } from '@/lib/session-file-open-target';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  getAvailablePathLauncherOptions,
  getPathLauncherId,
  PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT,
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  readStoredPathLauncherPreference,
  resolveSelectedPathLauncher,
  type PathLauncherOption,
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

/** A context-menu row owned by an agent-written Markdown file link. */
export type MarkdownAgentFileLinkMenuAction = {
  readonly kind: 'action';
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly run: () => void;
};

/** A nested group of alternate path launchers. */
export type MarkdownAgentFileLinkMenuSubmenu = {
  readonly kind: 'submenu';
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly items: readonly MarkdownAgentFileLinkMenuAction[];
};

export type MarkdownAgentFileLinkMenuItem =
  | MarkdownAgentFileLinkMenuAction
  | MarkdownAgentFileLinkMenuSubmenu;

export type SessionFileActions = {
  /** Absolute path on the machine that owns the file, when it resolves. */
  readonly resolveHostPath: (filePath: string) => string | null;
  readonly copyPath: (filePath: string) => void;
  /** Non-null only in the desktop app with the file on this machine. */
  readonly localHost: SessionFileLocalHostActionSet | null;
  /** The remote stand-in for the local-host actions. */
  readonly download: ((filePath: string) => void) | null;
  /** The subset the file-error card renders, or undefined with nothing to offer. */
  readonly buildErrorActions: (
    filePath: string,
    snapshot?: FileWorkspaceBinarySnapshot
  ) => SessionFileErrorActions | undefined;
  /**
   * Context-menu actions for a path an agent wrote in Markdown. Unlike the
   * file-tree menu, this deliberately never offers download/share remotely:
   * outside the owning local Electron machine it is Copy Path only.
   */
  readonly buildMarkdownLinkMenuItems: (href: string) => readonly MarkdownAgentFileLinkMenuItem[];
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
  const nativeShell = isNativeAppShell();
  const exportingRef = useRef(false);
  const [sharing, setSharing] = useState(false);
  const [pathLauncherPreference, setPathLauncherPreference] = useState(
    readStoredPathLauncherPreference
  );
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
    (filePath: string) => resolveLocalWorkspaceFilePath(workspacePath, filePath, isLocalMachine),
    [isLocalMachine, workspacePath]
  );

  // Keep the Markdown menu's "Open in" target aligned with the session-header
  // launcher preference, including changes made in Settings while a chat stays
  // mounted behind another tab.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const refresh = () => setPathLauncherPreference(readStoredPathLauncherPreference());
    const onStorage = (event: StorageEvent) => {
      if (event.key === PATH_LAUNCHER_PREFERENCE_STORAGE_KEY) refresh();
    };
    window.addEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const reportLocalActionFailure = useCallback(
    (
      action: 'reveal' | 'open' | 'editor',
      filePath: string,
      resolvedPath: string | null,
      error: unknown
    ) => {
      const errorText =
        error instanceof Error
          ? error.message
          : error && typeof error === 'object' && 'error' in error
            ? String(error.error)
            : String(error);
      const details = {
        action,
        filePath,
        resolvedPath,
        workspacePath,
        sessionId: session?.id,
        machineId: session?.machineId,
        localMachineId,
        error: errorText,
        ...(error && typeof error === 'object' && !(error instanceof Error)
          ? { result: error }
          : {}),
        ...(error instanceof Error ? { stack: error.stack } : {}),
      };
      console.error('[session-file-actions] Local file action failed', details, error);
      const description =
        errorText === 'path_unresolved' || errorText === 'invalid_path'
          ? t(
              'sessions.fileActions.pathUnresolved',
              'The file path could not be resolved. Copy the details to check the requested path and workspace folder.'
            )
          : errorText === 'ipc_unavailable'
            ? t(
                'sessions.fileActions.bridgeUnavailable',
                'The desktop connection is unavailable. Restart Lody and try again.'
              )
            : errorText === 'not_found' || errorText === 'ENOENT' || errorText === 'ENOTDIR'
              ? t(
                  'sessions.fileActions.missingHelp',
                  'The file may have moved or been deleted. Refresh the preview and check its location.'
                )
              : errorText === 'EACCES' || errorText === 'EPERM'
                ? t(
                    'sessions.fileActions.permissionHelp',
                    'Lody cannot access this file. Check file permissions and system privacy settings.'
                  )
                : action === 'editor'
                  ? t(
                      'sessions.fileActions.editorHelp',
                      'Check that the selected editor is installed and its command is correct in Settings. You can also reveal the file in your file manager.'
                    )
                  : t(
                      'sessions.fileActions.systemOpenHelp',
                      'Try opening the file from your file manager. Copy the details below to inspect the system error.'
                    );
      const title =
        action === 'reveal'
          ? t('sessions.fileActions.revealFailed', 'Could not reveal that file.')
          : action === 'editor'
            ? t('sessions.pathLaunchFailed', 'Failed to open path')
            : t('sessions.fileActions.openFailed', 'Could not open that file.');
      toast.error(title, {
        description,
        duration: 10_000,
        action: {
          label: t('sessions.fileActions.copyErrorDetails', 'Copy error details'),
          onClick: () => {
            void writeTextToClipboard(JSON.stringify(details, null, 2)).then((copied) => {
              if (!copied)
                toast.error(t('sessions.fileViewer.pathCopyFailed', 'Failed to copy file path'));
            });
          },
        },
      });
    },
    [localMachineId, session?.id, session?.machineId, t, workspacePath]
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

  const runEditorAction = useCallback(
    (launcher: PathLauncherOption, filePath: string) => {
      const path = resolveHostPath(filePath);
      if (!path) {
        reportLocalActionFailure('editor', filePath, null, 'path_unresolved');
        return;
      }
      void (async () => {
        try {
          const services = getIpcServices();
          if (!services) {
            reportLocalActionFailure('editor', filePath, path, 'ipc_unavailable');
            return;
          }
          const result = await services.app.launchLocalPath(
            buildPathLauncherLaunchInput(launcher, path, platform, 'file')
          );
          if (!result.launched) reportLocalActionFailure('editor', filePath, path, result);
        } catch (error) {
          reportLocalActionFailure('editor', filePath, path, error);
        }
      })();
    },
    [platform, reportLocalActionFailure, resolveHostPath]
  );

  const launcherCandidates = useMemo(() => {
    if (!isElectronRenderer) return null;
    return getAvailablePathLauncherOptions({
      customLaunchers: pathLauncherPreference.customLaunchers,
      isElectron: true,
      platform,
    });
  }, [isElectronRenderer, pathLauncherPreference.customLaunchers, platform]);

  // The Files tree and preview continue to offer the configured selection as
  // soon as a local host path exists. Markdown needs the stricter probed list
  // below because it promises equivalence with the visible header control.
  const selectedEditorLauncher = useMemo(
    () =>
      launcherCandidates
        ? resolveSelectedPathLauncher(pathLauncherPreference.selectedLauncherId, launcherCandidates)
        : null,
    [launcherCandidates, pathLauncherPreference.selectedLauncherId]
  );

  // The header deliberately advertises only launchers that the desktop bridge
  // has found. Use the identical probe here so "Open in" cannot name a stale
  // preference that is absent from the top control.
  const [availableLauncherIds, setAvailableLauncherIds] = useState(new Set<string>());
  useEffect(() => {
    if (!isElectronRenderer || !workspacePath || !launcherCandidates) {
      setAvailableLauncherIds(new Set());
      return undefined;
    }
    const services = getIpcServices();
    if (!services) return undefined;
    let cancelled = false;
    void services.app
      .probePathLaunchers({
        launchers: buildPathLauncherProbes(launcherCandidates, workspacePath, platform),
      })
      .then(
        (result) => {
          if (!cancelled) setAvailableLauncherIds(new Set(result.availableIds));
        },
        () => {
          if (!cancelled) setAvailableLauncherIds(new Set());
        }
      );
    return () => {
      cancelled = true;
    };
  }, [isElectronRenderer, launcherCandidates, platform, workspacePath]);

  const availableEditorLaunchers = useMemo(() => {
    if (!launcherCandidates) return null;
    const options = launcherCandidates.filter((launcher) =>
      availableLauncherIds.has(getPathLauncherId(launcher))
    );
    if (options.length === 0) return null;
    const selected = resolveSelectedPathLauncher(
      pathLauncherPreference.selectedLauncherId,
      options
    );
    return {
      selected,
      alternatives: options.filter(
        (option) => getPathLauncherId(option) !== getPathLauncherId(selected)
      ),
    };
  }, [availableLauncherIds, launcherCandidates, pathLauncherPreference.selectedLauncherId]);

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

    const runLocalAction = (
      action: 'reveal' | 'open' | 'editor',
      filePath: string,
      run: (
        services: NonNullable<ReturnType<typeof getIpcServices>>,
        path: string
      ) => Promise<unknown | null>
    ) => {
      const path = resolveHostPath(filePath);
      if (!path) {
        reportLocalActionFailure(action, filePath, null, 'path_unresolved');
        return;
      }
      void (async () => {
        try {
          const services = getIpcServices();
          if (!services) {
            reportLocalActionFailure(action, filePath, path, 'ipc_unavailable');
            return;
          }
          const failure = await run(services, path);
          if (failure !== null) reportLocalActionFailure(action, filePath, path, failure);
        } catch (error) {
          reportLocalActionFailure(action, filePath, path, error);
        }
      })();
    };

    return {
      revealLabel: resolveRevealFileLabel(platform, t),
      openLabel: (filePath: string) => resolveOpenFileLabel(filePath, t),
      reveal: (filePath) =>
        runLocalAction('reveal', filePath, async (services, path) => {
          const result = await services.app.revealLocalPath(path);
          return result.revealed ? null : result;
        }),
      openInDefaultApp: (filePath) =>
        runLocalAction('open', filePath, async (services, path) => {
          const result = await services.app.openLocalPath(path);
          return result.opened ? null : result;
        }),
      editor: selectedEditorLauncher
        ? {
            label: t('sessions.fileActions.openInEditor', 'Open in {{editor}}', {
              editor: selectedEditorLauncher.label,
            }),
            open: (filePath) => runEditorAction(selectedEditorLauncher, filePath),
          }
        : null,
    };
  }, [
    availability.localHost,
    runEditorAction,
    platform,
    reportLocalActionFailure,
    resolveHostPath,
    selectedEditorLauncher,
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
      if (nativeShell) {
        if (exportingRef.current) return;
        exportingRef.current = true;
        setSharing(true);
      }
      void (async () => {
        try {
          const exportBytes = async (bytes: Uint8Array) => {
            if (nativeShell) await shareFileBytesNatively(getDownloadFileName(filePath), bytes);
            else downloadBytesAsFile(filePath, bytes);
          };
          const result = await fileProvider.openFile(filePath);
          if (result.status !== 'ready') {
            reportUnavailable(result.reason);
            return;
          }
          const snapshot = result.snapshot;
          if (snapshot.kind === 'text') {
            await exportBytes(new TextEncoder().encode(snapshot.text));
            return;
          }
          if (snapshot.kind === 'binary' && snapshot.bytes) {
            await exportBytes(snapshot.bytes);
            return;
          }
          // A `binary` snapshot with no bytes is the machine declining to send
          // them, which is the same "too big for one response" situation.
          reportUnavailable('no-bytes');
        } catch {
          toast.error(
            nativeShell
              ? t('sessions.fileActions.shareFailed', 'Could not share that file.')
              : t('sessions.fileActions.downloadFailed', 'Could not download that file.')
          );
        } finally {
          if (nativeShell) {
            exportingRef.current = false;
            setSharing(false);
          }
        }
      })();
    };
  }, [availability.download, fileProvider, nativeShell, session, t]);

  const buildErrorActions = useCallback(
    (
      filePath: string,
      snapshot?: FileWorkspaceBinarySnapshot
    ): SessionFileErrorActions | undefined => {
      const trimmed = filePath.trim();
      if (!session || !trimmed) return undefined;
      const onCopyPath = () => copyPath(trimmed);
      if (!localHost || !resolveHostPath(trimmed))
        return {
          onCopyPath,
          ...(nativeShell && download && snapshot?.bytes
            ? { onShare: () => download(trimmed), sharing }
            : {}),
        };
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
    [copyPath, download, localHost, nativeShell, resolveHostPath, session, sharing]
  );

  const resolveMarkdownLinkFilePath = useCallback(
    (href: string): string | null => {
      const trimmed = href.trim();
      if (!trimmed) return null;
      return resolveSessionFileOpenTarget({
        rawPath: trimmed,
        pathKind: 'markdown-href',
        workspacePath,
        preserveWorktreePath: isElectronRenderer && isLocalMachine,
      }).filePath;
    },
    [isElectronRenderer, isLocalMachine, workspacePath]
  );

  const buildMarkdownLinkMenuItems = useCallback(
    (href: string): readonly MarkdownAgentFileLinkMenuItem[] => {
      const filePath = resolveMarkdownLinkFilePath(href);
      if (!filePath) return [];

      const items: MarkdownAgentFileLinkMenuItem[] = [
        {
          kind: 'action',
          id: 'copy-path',
          label: t('sessions.fileActions.copyPath', 'Copy Path'),
          icon: Copy,
          run: () => copyPath(filePath),
        },
      ];

      // The exact same local-host gate protects every path handed to Electron.
      // A remote agent's href can still be copied, but must never reach this
      // viewer's shell or advertise actions that will fail.
      if (!localHost || !resolveHostPath(filePath)) return items;

      items.push({
        kind: 'action',
        id: 'open-file',
        label: t('sessions.fileActions.openFile', 'Open File'),
        icon: ExternalLink,
        run: () => localHost.openInDefaultApp(filePath),
      });
      if (availableEditorLaunchers) {
        items.push({
          kind: 'action',
          id: 'open-in-editor',
          label: t('sessions.fileActions.openInEditor', 'Open in {{editor}}', {
            editor: availableEditorLaunchers.selected.label,
          }),
          icon: ExternalLink,
          run: () => runEditorAction(availableEditorLaunchers.selected, filePath),
        });
      }

      const alternatives = availableEditorLaunchers?.alternatives ?? [];
      if (alternatives.length > 0) {
        items.push({
          kind: 'submenu',
          id: 'open-with',
          label: t('sessions.fileActions.openWith', 'Open with'),
          icon: ExternalLink,
          items: alternatives.map((launcher) => ({
            kind: 'action' as const,
            id: `open-with:${getPathLauncherId(launcher)}`,
            label: launcher.label,
            icon: ExternalLink,
            run: () => runEditorAction(launcher, filePath),
          })),
        });
      }

      items.push({
        kind: 'action',
        id: 'reveal',
        label: localHost.revealLabel,
        icon: FolderOpen,
        run: () => localHost.reveal(filePath),
      });
      return items;
    },
    [
      copyPath,
      availableEditorLaunchers,
      localHost,
      resolveHostPath,
      resolveMarkdownLinkFilePath,
      runEditorAction,
      t,
    ]
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
        label: nativeShell
          ? t('sessions.fileActions.share', 'Share file…')
          : t('sessions.fileActions.download', 'Download file'),
        icon: nativeShell ? Share2 : Download,
        run: download,
      });
    }
    return items;
  }, [copyPath, download, localHost, nativeShell, session, t]);

  return {
    resolveHostPath,
    copyPath,
    localHost,
    download,
    buildErrorActions,
    buildMarkdownLinkMenuItems,
    menuItems,
  };
}
