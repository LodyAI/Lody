import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AtSign, Copy, Download, FolderOpen } from 'lucide-react';
import type { FileTreeItem } from '@lody/shared';
import { ContextMenuItem, ContextMenuSeparator } from '@/ui/context-menu';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { usePathLauncherPreference } from '@/hooks/use-path-launcher-preference';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { getBasename } from '@/lib/utils';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';
import {
  buildPathLauncherLaunchInput,
  buildPathLauncherProbes,
  canPathLauncherOpenFile,
  getAvailablePathLauncherOptions,
  getPathLauncherId,
  resolveSelectedPathLauncher,
  type PathLauncherOption,
} from '@/lib/session-path-launchers';
import { getPathLauncherIcon } from '@/components/icons/path-launcher-icon';
import {
  FILE_TREE_DOWNLOAD_LIMITS,
  findFileTreeItem,
  planFileTreeFolderDownload,
} from '@/lib/file-tree-download';
import {
  buildFolderArchiveFileName,
  buildWorkspaceFolderArchive,
  readWorkspaceFileBytes,
  revealLocalPathInFileManager,
  saveDownloadedFile,
  type WorkspaceFileSaveOutcome,
} from '@/lib/workspace-file-download';

/**
 * The file tree's right-click menu.
 *
 * Two groups. The upper one is what the user does WITH the file — mention it in
 * the conversation, open it, get it out of the workspace — and the lower one is
 * the two copy-path variants.
 *
 * Inside the upper group, one pair is mutually exclusive and decided by WHERE
 * the files are:
 *
 * - files on ANOTHER machine can only be **downloaded**, because the bytes have
 *   to travel to this renderer before they can be anywhere else;
 * - files on THIS machine are already on disk, so downloading them would write
 *   a second copy of a file the user can already open. Those rows get **reveal
 *   in the OS file manager** plus **open in the selected editor** instead.
 *
 * `isLocalMachine` is what distinguishes the two. `workspaceRootPath` is NOT:
 * it resolves on the session's own machine, remote included, which is exactly
 * why Copy path can offer it either way.
 */

export type FileTreeRowMentionTarget = {
  readonly path: string;
  readonly isDirectory: boolean;
};

export type FileTreeRowMenuConfig = {
  /** Reads file bytes for a download. Without it, no row offers a download. */
  readonly provider?: FileWorkspaceProvider | null;
  /**
   * Absolute path of this tree's workspace root ON THE SESSION'S OWN MACHINE,
   * remote included. Enables Copy path; it is not a local-machine signal.
   */
  readonly workspaceRootPath?: string | null;
  /** True when that machine is the one this renderer runs on. */
  readonly isLocalMachine?: boolean;
  /**
   * Writes an `@path` mention into the active composer. Returns false when
   * nothing was written, so the menu can stay silent instead of implying it
   * added something.
   */
  readonly onMentionFile?: (target: FileTreeRowMentionTarget) => boolean;
};

/** Renders the menu items for one row. */
export type FileTreeRowMenuRenderer = (path: string) => ReactNode;

/**
 * The tree's paths are workspace-relative and always `/`-joined; the root is an
 * absolute path on the session's machine. Windows is detected from the root's
 * own shape (drive letter or UNC) rather than the renderer's platform — the
 * machine may not be this one, so the local platform proves nothing about it.
 */
export function joinLocalPath(rootPath: string, relativePath: string): string {
  const isWindowsRoot = /^[A-Za-z]:[\\/]/u.test(rootPath) || rootPath.startsWith('\\\\');
  const trimmedRoot = rootPath.replace(/[\\/]+$/u, '');
  if (!relativePath) return trimmedRoot;
  return isWindowsRoot
    ? `${trimmedRoot}\\${relativePath.replaceAll('/', '\\')}`
    : `${trimmedRoot}/${relativePath}`;
}

/**
 * The launcher to offer for opening a single FILE, or null when none is
 * installed.
 *
 * Probed rather than assumed: offering "Open in VS Code" to someone without VS
 * Code is a menu item that can only fail. `canPathLauncherOpenFile` drops the
 * file managers and Warp first, so a user whose folder launcher is Finder still
 * gets their first available editor here rather than an entry that would hand
 * the file to Preview.app.
 */
function useFileOpenLauncher(targetPath: string | null): PathLauncherOption | null {
  const preference = usePathLauncherPreference();
  const [availableLauncherIds, setAvailableLauncherIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const isElectron = isElectronRenderer();
  const platform = typeof window === 'undefined' ? undefined : window.__LODY_PLATFORM__?.os;

  const candidates = useMemo(
    () =>
      getAvailablePathLauncherOptions({
        customLaunchers: preference.customLaunchers,
        isElectron,
        platform,
      }).filter(canPathLauncherOpenFile),
    [isElectron, platform, preference.customLaunchers]
  );

  useEffect(() => {
    if (!isElectron || !targetPath || candidates.length === 0) {
      setAvailableLauncherIds(new Set());
      return undefined;
    }
    const services = getIpcServices();
    if (!services) return undefined;

    let cancelled = false;
    void services.app
      .probePathLaunchers({ launchers: buildPathLauncherProbes(candidates, targetPath, platform) })
      .then(
        (result) => {
          if (!cancelled) setAvailableLauncherIds(new Set(result.availableIds));
        },
        () => {
          // A failed probe must not advertise a launcher whose presence could
          // not be established.
          if (!cancelled) setAvailableLauncherIds(new Set());
        }
      );
    return () => {
      cancelled = true;
    };
  }, [candidates, isElectron, platform, targetPath]);

  return useMemo(() => {
    const available = candidates.filter((launcher) =>
      availableLauncherIds.has(getPathLauncherId(launcher))
    );
    if (available.length === 0) return null;
    return resolveSelectedPathLauncher(preference.selectedLauncherId, available);
  }, [availableLauncherIds, candidates, preference.selectedLauncherId]);
}

export function useFileTreeRowMenu(
  config: FileTreeRowMenuConfig | undefined,
  fileTree: readonly FileTreeItem[]
): FileTreeRowMenuRenderer | undefined {
  const { t } = useTranslation();
  const provider = config?.provider ?? null;
  const workspaceRootPath = config?.workspaceRootPath?.trim() || null;
  const onMentionFile = config?.onMentionFile;
  // Reveal and open are Electron bridges; a browser host has no file manager or
  // local editor to talk to even when the files happen to be local.
  const isLocal = Boolean(config?.isLocalMachine) && Boolean(workspaceRootPath);
  const canReveal = isLocal && isElectronRenderer();
  const canDownload = Boolean(provider) && !isLocal;
  const openLauncher = useFileOpenLauncher(canReveal ? workspaceRootPath : null);

  const reportSave = useStableCallback(
    (outcome: WorkspaceFileSaveOutcome, toastId: string | number) => {
      if (outcome.kind === 'saved') {
        toast.success(t('sessions.files.downloadSaved', 'Download saved'), { id: toastId });
        return;
      }
      if (outcome.kind === 'canceled') {
        toast.dismiss(toastId);
        return;
      }
      toast.error(t('sessions.files.downloadFailed', 'Failed to download'), { id: toastId });
    }
  );

  const downloadFile = useStableCallback(async (path: string) => {
    if (!provider) return;
    const toastId = toast.loading(t('sessions.files.downloadPreparing', 'Preparing download…'));
    const read = await readWorkspaceFileBytes(provider, path);
    if (!read.ok) {
      toast.error(read.message ?? t('sessions.files.downloadFailed', 'Failed to download'), {
        id: toastId,
      });
      return;
    }
    reportSave(
      await saveDownloadedFile({ fileName: getBasename(path), bytes: read.bytes }),
      toastId
    );
  });

  const downloadFolder = useStableCallback(async (path: string) => {
    if (!provider) return;
    const plan = planFileTreeFolderDownload(fileTree, path);

    if (plan.status === 'needs-directory-load') {
      // The index has never listed these directories, so their contents are not
      // knowable here and a zip built now would silently be short. Ask the
      // machine for them so the retry the user is being told to make succeeds.
      for (const directoryId of plan.lazyDirectoryIds) {
        void provider.initializeDirectory?.(directoryId).catch(() => undefined);
      }
      toast.error(
        t(
          'sessions.files.downloadFolderNotLoaded',
          'This folder is still loading. Expand it and try again.'
        )
      );
      return;
    }
    if (plan.status === 'empty') {
      toast.error(t('sessions.files.downloadFolderEmpty', 'This folder has no files to download'));
      return;
    }
    if (plan.status === 'too-many-files') {
      toast.error(
        t(
          'sessions.files.downloadFolderTooManyFiles',
          'This folder has {{count}} files; at most {{limit}} can be downloaded at once.',
          { count: plan.fileCount, limit: plan.limit }
        )
      );
      return;
    }

    const toastId = toast.loading(
      t('sessions.files.downloadFolderPreparing', 'Preparing {{count}} files…', {
        count: plan.filePaths.length,
      })
    );
    const archive = await buildWorkspaceFolderArchive({
      provider,
      folderPath: path,
      filePaths: plan.filePaths,
    });
    if (!archive.ok) {
      toast.error(
        archive.reason === 'too-large'
          ? t(
              'sessions.files.downloadFolderTooLarge',
              'This folder is larger than the {{limit}} MB download limit.',
              { limit: Math.floor(FILE_TREE_DOWNLOAD_LIMITS.maxTotalBytes / (1024 * 1024)) }
            )
          : t('sessions.files.downloadFolderEmpty', 'This folder has no files to download'),
        { id: toastId }
      );
      return;
    }

    const outcome = await saveDownloadedFile({
      fileName: buildFolderArchiveFileName(path),
      bytes: archive.bytes,
    });
    if (outcome.kind === 'saved' && archive.skippedPaths.length > 0) {
      // An incomplete archive must say so: it is indistinguishable from a
      // complete one once it is on disk.
      toast.warning(
        t(
          'sessions.files.downloadFolderPartial',
          'Saved {{count}} files; {{skipped}} could not be read.',
          { count: archive.fileCount, skipped: archive.skippedPaths.length }
        ),
        { id: toastId }
      );
      return;
    }
    reportSave(outcome, toastId);
  });

  const revealPath = useStableCallback(async (path: string) => {
    if (!workspaceRootPath) return;
    const outcome = await revealLocalPathInFileManager(joinLocalPath(workspaceRootPath, path));
    if (outcome.kind === 'failed') {
      toast.error(t('sessions.files.revealFailed', 'Failed to open the file manager'));
    }
  });

  const openInLauncher = useStableCallback(async (path: string) => {
    if (!workspaceRootPath || !openLauncher) return;
    const services = getIpcServices();
    if (!services) return;
    try {
      const request = buildPathLauncherLaunchInput(
        openLauncher,
        joinLocalPath(workspaceRootPath, path),
        typeof window === 'undefined' ? undefined : window.__LODY_PLATFORM__?.os
      );
      const result = await services.app.launchLocalPath(request);
      if (!result.launched) {
        toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
      }
    } catch {
      toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
    }
  });

  const copyPath = useStableCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('sessions.files.pathCopied', 'Path copied'));
    } catch {
      toast.error(t('sessions.pathCopyFailed', 'Failed to copy path'));
    }
  });

  const mentionFile = useStableCallback((target: FileTreeRowMentionTarget) => {
    if (onMentionFile?.(target) === false) {
      // Already mentioned, or no composer took it. Saying nothing would read as
      // a dead menu item.
      toast.info(t('sessions.files.mentionUnavailable', 'Already added to this message'));
    }
  });

  const revealLabel = useRevealInFileManagerLabel();

  return useMemo(() => {
    const hasAnyAction = Boolean(onMentionFile) || canDownload || canReveal || workspaceRootPath;
    if (!hasAnyAction) return undefined;

    return (path: string) => {
      const item = findFileTreeItem(fileTree, path);
      const isDirectory = item?.type === 'directory';
      const OpenLauncherIcon = openLauncher ? getPathLauncherIcon(openLauncher) : null;

      return (
        <>
          {onMentionFile ? (
            <ContextMenuItem
              onSelect={() => {
                mentionFile({ path, isDirectory });
              }}
            >
              <AtSign className="h-3.5 w-3.5" />
              {t('sessions.files.addToConversation', 'Add to conversation')}
            </ContextMenuItem>
          ) : null}

          {/* Opening a DIRECTORY in an editor is the workspace-root action the
              header already owns; this entry is for the file the user clicked. */}
          {canReveal && openLauncher && OpenLauncherIcon && !isDirectory ? (
            <ContextMenuItem
              onSelect={() => {
                void openInLauncher(path);
              }}
            >
              <OpenLauncherIcon className="h-3.5 w-3.5" />
              {t('sessions.files.openInLauncher', 'Open in {{launcher}}', {
                launcher: openLauncher.label,
              })}
            </ContextMenuItem>
          ) : null}

          {canReveal ? (
            <ContextMenuItem
              onSelect={() => {
                void revealPath(path);
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {revealLabel}
            </ContextMenuItem>
          ) : null}

          {canDownload ? (
            <ContextMenuItem
              onSelect={() => {
                void (isDirectory ? downloadFolder(path) : downloadFile(path));
              }}
            >
              <Download className="h-3.5 w-3.5" />
              {t('sessions.files.download', 'Download')}
            </ContextMenuItem>
          ) : null}

          <ContextMenuSeparator />

          {workspaceRootPath ? (
            <ContextMenuItem
              onSelect={() => {
                void copyPath(joinLocalPath(workspaceRootPath, path));
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('sessions.files.copyPath', 'Copy path')}
            </ContextMenuItem>
          ) : null}

          <ContextMenuItem
            onSelect={() => {
              void copyPath(path);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('sessions.files.copyRelativePath', 'Copy relative path')}
          </ContextMenuItem>
        </>
      );
    };
  }, [
    canDownload,
    canReveal,
    copyPath,
    downloadFile,
    downloadFolder,
    fileTree,
    mentionFile,
    onMentionFile,
    openInLauncher,
    openLauncher,
    revealLabel,
    revealPath,
    t,
    workspaceRootPath,
  ]);
}

/**
 * The file manager's own product name, so the item reads the way the OS does.
 * Not derived from the launcher list: this action reveals a FILE through
 * `shell.showItemInFolder`, which is a different operation than opening a
 * folder with a launcher command.
 */
export function useRevealInFileManagerLabel(): string {
  const { t } = useTranslation();
  const os = typeof window === 'undefined' ? undefined : window.__LODY_PLATFORM__?.os;
  if (os === 'darwin') {
    return t('sessions.files.revealInFinder', 'Reveal in Finder');
  }
  if (os === 'win32') {
    return t('sessions.files.revealInExplorer', 'Reveal in File Explorer');
  }
  return t('sessions.files.revealInFileManager', 'Reveal in File Manager');
}
