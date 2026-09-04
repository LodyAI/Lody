/**
 * What a surface may offer to do with a session file OUTSIDE the in-app viewer
 * — the file tree's context menu, the side panel's ⋯ menu, and the error card
 * all read this one model.
 *
 * The split it encodes is the whole point: reaching the machine's shell (open
 * with the OS, reveal in the file manager, hand to the configured editor) needs
 * the desktop bridge AND the file's machine to be this machine, while copying
 * the path works anywhere and downloading is what stands in for all of it when
 * the file lives somewhere this client cannot touch. A surface must never
 * present an action from the other side of that line.
 */

export type SessionFileActionPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';

type Translation = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

export function normalizeSessionFileActionPlatform(
  platform: string | null | undefined
): SessionFileActionPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform;
  return 'unknown';
}

/** The file manager has a name on macOS and Windows; elsewhere it does not. */
export function resolveRevealFileLabel(
  platform: SessionFileActionPlatform,
  t: Translation
): string {
  if (platform === 'darwin') return t('sessions.fileActions.revealInFinder', 'Show in Finder');
  if (platform === 'win32')
    return t('sessions.fileActions.revealInExplorer', 'Show in File Explorer');
  return t('sessions.fileActions.revealInFileManager', 'Reveal in file manager');
}

const HTML_PATH = /\.(?:html|htm)$/iu;

/**
 * `shell.openPath` always means "the OS default handler". For HTML that really
 * is a browser, and naming it beats a generic label; for anything else the
 * handler is unknown here, so the label stays generic.
 */
export function resolveOpenFileTarget(filePath: string): 'browser' | 'default-app' {
  return HTML_PATH.test(filePath.trim()) ? 'browser' : 'default-app';
}

export function resolveOpenFileLabel(filePath: string, t: Translation): string {
  return resolveOpenFileTarget(filePath) === 'browser'
    ? t('sessions.fileActions.openInBrowser', 'Open in browser')
    : t('sessions.fileActions.openInDefaultApp', 'Open in default app');
}

export type SessionFileActionAvailability = {
  /** Open with the OS, reveal in the file manager, open in the chosen editor. */
  readonly localHost: boolean;
  /** The remote stand-in for all of the above. */
  readonly download: boolean;
};

export function resolveSessionFileActionAvailability({
  isElectronRenderer,
  isLocalMachine,
  hasHostPath,
  hasFileProvider,
}: {
  readonly isElectronRenderer: boolean;
  readonly isLocalMachine: boolean;
  readonly hasHostPath: boolean;
  readonly hasFileProvider: boolean;
}): SessionFileActionAvailability {
  const localHost = isElectronRenderer && isLocalMachine && hasHostPath;
  // Download is deliberately the complement, not an everywhere action: with the
  // real file one keystroke away, a copy in ~/Downloads is a decoy.
  return { localHost, download: !localHost && hasFileProvider };
}

/**
 * Handing the file to the OS. Optional even when the error card has actions —
 * a browser tab or a session on another machine gets the copyable path and
 * nothing else, rather than a button that cannot work.
 */
export type SessionFileLocalHostActions = {
  readonly openTarget: 'browser' | 'default-app';
  /** "Show in Finder" / "Show in File Explorer" — resolved per host OS. */
  readonly revealLabel: string;
  readonly onOpen: () => void;
  readonly onReveal: () => void;
};

/**
 * Ways out of a file Lody itself will not render. Copying the path is always
 * possible — every platform can put text on the clipboard, and the path is the
 * whole answer for a file on a machine this client cannot touch.
 */
export type SessionFileErrorActions = {
  readonly onCopyPath: () => void;
  readonly localHost?: SessionFileLocalHostActions;
};
