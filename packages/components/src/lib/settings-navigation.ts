export type SettingsBackDestination =
  | { kind: 'settings-list' }
  | { kind: 'source'; to: string }
  | { kind: 'chat' };

type GetSettingsBackDestinationOptions = {
  isMobile: boolean;
  settingsListPage: boolean;
  from?: string;
};

export function getSettingsBackDestination({
  isMobile,
  settingsListPage,
  from,
}: GetSettingsBackDestinationOptions): SettingsBackDestination {
  if (isMobile && !settingsListPage) {
    return { kind: 'settings-list' };
  }

  const source = resolveSettingsCloseTo(from);
  if (source) {
    return { kind: 'source', to: source };
  }

  return { kind: 'chat' };
}

/** Whether `pathname` is anywhere inside the workspace's settings section. */
export function isSettingsPath(pathname: string, workspaceName: string): boolean {
  const base = `/${workspaceName}/settings`;
  return pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/`);
}

/**
 * Where ⌘, / Esc should land when CLOSING settings: the path settings was opened from
 * (carried in the `from` search param so it survives tab navigation), or `null` to mean
 * "fall back to the chat landing". Rejects non-app and protocol-relative paths.
 */
export function resolveSettingsCloseTo(from: string | undefined): string | null {
  if (from && from.startsWith('/') && !from.startsWith('//')) {
    return from;
  }
  return null;
}
