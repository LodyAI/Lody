export type NightlyDownload = {
  platform: 'mac' | 'win' | 'linux';
  label: string;
  href: string;
};

export type NightlyRelease = {
  version: string;
  minimumStableVersion: string;
  downloads: NightlyDownload[];
};

/** The site receives a public distribution URL, never storage credentials. */
export function resolveNightlyDownloadBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return null;
    if (!url.pathname.split('/').includes('nightly')) return null;
    return url.href.replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No latest aliases or metadata-provided absolute URLs: all six files must agree. */
export function parseNightlyRelease(value: unknown, base: string): NightlyRelease {
  const root = resolveNightlyDownloadBase(base);
  if (
    !root ||
    !isRecord(value) ||
    value.schema !== 1 ||
    value.channel !== 'nightly' ||
    typeof value.version !== 'string' ||
    typeof value.minimumStableVersion !== 'string' ||
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/u.test(value.minimumStableVersion) ||
    !/^\d{1,8}\.\d{1,8}\.\d{1,8}-nightly\.[1-9]\d{0,7}$/u.test(value.version) ||
    !isRecord(value.downloads) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('Invalid Nightly release manifest');
  }
  const targets: Array<[NightlyDownload['platform'], string, string]> = [
    ['mac', 'Apple Silicon', 'arm64.dmg'],
    ['mac', 'Intel', 'x64.dmg'],
    ['win', 'Windows x64', 'x64-setup.exe'],
    ['linux', 'AppImage · x64', 'x64.AppImage'],
    ['linux', 'Debian / Ubuntu · x64', 'x64.deb'],
    ['linux', 'Snap · x64', 'x64.snap'],
  ];
  const { downloads: mapping, files } = value;
  const downloads = targets.map(([platform, label, suffix]) => {
    const file = `Lody-${value.version}-${suffix.replace(/\.([^.]+)$/u, '-nightly.$1')}`;
    if (mapping[file] !== file || !files.includes(file)) {
      throw new Error('Incomplete Nightly release manifest');
    }
    return { platform, label, href: `${root}/${encodeURIComponent(file)}` };
  });
  return { version: value.version, minimumStableVersion: value.minimumStableVersion, downloads };
}
